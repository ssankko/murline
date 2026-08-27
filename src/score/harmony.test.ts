import { AccidentalEnum, ChordSymbolEnum } from 'opensheetmusicdisplay';
import { describe, expect, test } from 'vitest';
import { analyzeHarmony, degreeOf, type KeyAt } from './harmony';
import {
  TICKS_PER_QUARTER,
  type ChordEvent,
  type ChordSymbol,
  type Note,
  type Onset,
  type Score,
} from './types';

const BAR = 4 * TICKS_PER_QUARTER;

const C_MAJOR: KeyAt = { tick: 0, sharps: 0, mode: 0 };
const A_MINOR: KeyAt = { tick: 0, sharps: 0, mode: 1 };

/** A MIDI number, or one with the accidental the score writes on it. */
type Pitch = number | [midi: number, written: -1 | 1];

/** The stub of an OSMD note that carries an accidental, the only thing the naming reads. */
function source(written: number): Note['source'] {
  const accidental =
    written > 0 ? AccidentalEnum.SHARP : written < 0 ? AccidentalEnum.FLAT : AccidentalEnum.NONE;
  return { Pitch: { Accidental: accidental } } as unknown as Note['source'];
}

/**
 * A hand-written Score: one whole-bar chord per bar in 4/4, given as MIDI numbers. The rest of the
 * OSMD references only matter to the sheet, so the test does without them.
 */
function scoreOf(bars: Pitch[][], key = C_MAJOR, chords: ChordSymbol[] = []): Score {
  const onsets: Onset[] = bars.map((pitches, bar) => ({
    tick: bar * BAR,
    measureIndex: bar,
    notes: pitches.map(
      (pitch): Note => ({
        midi: typeof pitch === 'number' ? pitch : pitch[0],
        staff: 0,
        hand: 'right',
        onsetTick: bar * BAR,
        durationTicks: BAR,
        tiedFrom: false,
        grace: false,
        strikeable: true,
        velocity: 80,
        measureIndex: bar,
        source: source(typeof pitch === 'number' ? 0 : pitch[1]),
      }),
    ),
  }));
  return {
    title: '',
    composer: '',
    partName: '',
    partCount: 1,
    staffCount: 1,
    onsets,
    playOrder: onsets.map((o, i) => ({ onsetIndex: i, tick: o.tick })),
    totalTicks: bars.length * BAR,
    tempoMap: [{ tick: 0, bpm: 60 }],
    hasTempo: true,
    constantTempo: true,
    hasDynamics: false,
    measures: bars.map((_, bar) => ({
      index: bar,
      number: bar + 1,
      startTick: bar * BAR,
      durationTicks: BAR,
      beatsPerBar: 4,
      beatUnit: 4,
    })),
    keys: [{ measureIndex: 0, sharps: key.sharps, mode: key.mode }],
    chords,
    harmony: [],
  };
}

const names = (events: ChordEvent[]) => events.map((e) => `${e.absolute} ${e.degree}`);

describe('the degree form', () => {
  test('reads the major scale by number and everything else with a sign', () => {
    expect(degreeOf(0, C_MAJOR, 0)).toBe('1');
    expect(degreeOf(7, C_MAJOR, 0)).toBe('5');
    expect(degreeOf(10, C_MAJOR, 0)).toBe('♭7');
    expect(degreeOf(3, C_MAJOR, 0)).toBe('♭3');
    // The same pitch class is the raised fourth or the flat fifth by how the note is written.
    expect(degreeOf(6, C_MAJOR, 1)).toBe('♯4');
    expect(degreeOf(6, C_MAJOR, -1)).toBe('♭5');
  });

  test('reads a minor key against the harmonic minor scale', () => {
    expect(degreeOf(9, A_MINOR, 0)).toBe('1');
    expect(degreeOf(0, A_MINOR, 0)).toBe('3');
    expect(degreeOf(8, A_MINOR, 0)).toBe('7');
    // The subtonic is a flat seventh; the raised sixth of the melodic minor is a sharp sixth.
    expect(degreeOf(7, A_MINOR, 0)).toBe('♭7');
    expect(degreeOf(6, A_MINOR, 0)).toBe('♯6');
  });

  test('follows the key in force, so a key change re-labels the same chord', () => {
    const score = scoreOf([[60, 64, 67], [62, 66, 69], [60, 64, 67]]);
    score.keys.push({ measureIndex: 1, sharps: 2, mode: 0 });
    expect(names(analyzeHarmony(score))).toEqual(['C 1', 'D 1', 'C ♭7']);
  });
});

describe('the naming rules', () => {
  test('a diminished triad reads as the dominant seventh a major third below', () => {
    expect(names(analyzeHarmony(scoreOf([[59, 62, 65]])))).toEqual(['G7/B 5⁷/7']);
  });

  test('a half-diminished seventh on a chromatic root reads as a dominant seventh', () => {
    expect(names(analyzeHarmony(scoreOf([[[54, 1], 57, 60, 64]])))).toEqual(['D7/F# 2⁷/♯4']);
  });

  test('a diminished seventh is spelled from its bass, and the key decides the sign', () => {
    expect(names(analyzeHarmony(scoreOf([[[54, 1], 57, 60, 63]])))).toEqual(['F#°7 ♯4°⁷']);
    const aFlatMajor = { tick: 0, sharps: -4, mode: 0 };
    expect(names(analyzeHarmony(scoreOf([[[56, -1], 59, 62, 65]], aFlatMajor)))).toEqual([
      'Ab°7 1°⁷',
    ]);
  });

  test('a chord tone other than the root in the bass makes a slash name', () => {
    expect(names(analyzeHarmony(scoreOf([[64, 67, 72]])))).toEqual(['C/E 1/3']);
  });

  test('one pitch class or octave doublings only carry the last name', () => {
    const score = scoreOf([[60, 64, 67], [60, 72], [60], [62, 65, 69]]);
    expect(names(analyzeHarmony(score))).toEqual(['C 1', 'Dm 2m']);
  });

  test('a tie chain counts once, so the bar it runs under keeps its own name', () => {
    // C3 is tied across both bars. Counted twice it drags the second bar into a C chord.
    const score = scoreOf([[48, 60, 64, 67], [48, 67, 70, 74]]);
    const start = score.onsets[0]!.notes[0]!;
    start.durationTicks = 2 * BAR;
    const continuation = score.onsets[1]!.notes[0]!;
    continuation.tiedFrom = true;
    continuation.strikeable = false;
    expect(names(analyzeHarmony(score))).toEqual(['C 1', 'Gm 5m']);
  });

  test('a grace note sounds in no unit, so it names no chord', () => {
    const score = scoreOf([[60, 64, 67, 70]]);
    const grace = score.onsets[0]!.notes[3]!;
    grace.grace = true;
    grace.durationTicks = 0;
    expect(names(analyzeHarmony(score))).toEqual(['C 1']);
  });

  test('an event points at the Onset where the harmony changes', () => {
    expect(analyzeHarmony(scoreOf([[60, 64, 67], [62, 65, 69]]))).toEqual([
      { onsetIndex: 0, tick: 0, measureIndex: 0, absolute: 'C', degree: '1' },
      { onsetIndex: 1, tick: BAR, measureIndex: 1, absolute: 'Dm', degree: '2m' },
    ]);
  });
});

describe('a file with its own chord symbols', () => {
  const symbol = (tick: number, text: string, root: number, kind: number, bass?: number): ChordSymbol => ({
    tick,
    measureIndex: tick / BAR,
    text,
    root,
    kind,
    bass,
  });

  test('the symbols are the harmony and the analysis never runs', () => {
    // The notes spell F major, which the symbols overrule.
    const score = scoreOf(
      [[65, 69, 72], [65, 69, 72]],
      C_MAJOR,
      [symbol(0, 'C9', 0, ChordSymbolEnum.dominantninth), symbol(BAR, 'G7/B', 7, ChordSymbolEnum.dominant, 11)],
    );
    // A ninth has no template of its own, so its text stands and its degree reads as the seventh.
    expect(names(analyzeHarmony(score))).toEqual(['C9 1⁷', 'G7/B 5⁷/7']);
  });

  test('two symbols over one Onset leave the later one', () => {
    const score = scoreOf([[60, 64, 67], [62, 65, 69]], C_MAJOR, [
      symbol(0, 'C', 0, ChordSymbolEnum.major),
      symbol(BAR / 2, 'G7', 7, ChordSymbolEnum.dominant),
      symbol(BAR, 'Dm', 2, ChordSymbolEnum.minor),
    ]);
    expect(analyzeHarmony(score).map((e) => `${e.onsetIndex} ${e.absolute}`)).toEqual([
      '0 C',
      '1 Dm',
    ]);
  });

  test('a sus kind keeps its text and reads "?" in the degree form', () => {
    const score = scoreOf(
      [[60, 65, 67]],
      C_MAJOR,
      [symbol(0, 'Csus4', 0, ChordSymbolEnum.suspendedfourth)],
    );
    expect(names(analyzeHarmony(score))).toEqual(['Csus4 ?']);
  });
});
