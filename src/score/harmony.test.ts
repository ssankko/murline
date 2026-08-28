import { AccidentalEnum, ChordSymbolEnum } from 'opensheetmusicdisplay';
import { describe, expect, test } from 'vitest';
import {
  analyzeHarmony,
  degreeOf,
  keyName,
  keyTable,
  parallelOf,
  relativeOf,
  scaleOf,
  signatureOf,
  toneWeight,
  tonicOf,
  type KeyAt,
} from './harmony';
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
const D_MAJOR: KeyAt = { tick: 0, sharps: 2, mode: 0 };

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

describe('the scale and the name of a key', () => {
  test('holds the seven pitch classes of the key, from its tonic', () => {
    expect(scaleOf(C_MAJOR)).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(scaleOf(A_MINOR)).toEqual([0, 2, 3, 5, 7, 8, 11]);
    expect(tonicOf(A_MINOR)).toBe(9);
  });

  test('names every key of the circle, spelled by letter', () => {
    const named = (mode: number) =>
      [...Array(15).keys()].map((i) => keyName({ tick: 0, sharps: i - 7, mode }));
    expect(named(0)).toEqual([
      'C\u266d major',
      'G\u266d major',
      'D\u266d major',
      'A\u266d major',
      'E\u266d major',
      'B\u266d major',
      'F major',
      'C major',
      'G major',
      'D major',
      'A major',
      'E major',
      'B major',
      'F\u266f major',
      'C\u266f major',
    ]);
    expect(named(1)).toEqual([
      'A\u266d minor',
      'E\u266d minor',
      'B\u266d minor',
      'F minor',
      'C minor',
      'G minor',
      'D minor',
      'A minor',
      'E minor',
      'B minor',
      'F\u266f minor',
      'C\u266f minor',
      'G\u266f minor',
      'D\u266f minor',
      'A\u266f minor',
    ]);
  });

  test('lays a major key out one entry per scale degree', () => {
    expect(keyTable(D_MAJOR)).toEqual([
      {
        degree: 1,
        note: 'D',
        pitch: 2,
        role: 'tonic',
        triad: 'D',
        notes: 'D F\u266f A',
        seventh: 'DM7',
      },
      {
        degree: 2,
        note: 'E',
        pitch: 4,
        role: 'supertonic',
        triad: 'Em',
        notes: 'E G B',
        seventh: 'Em7',
      },
      {
        degree: 3,
        note: 'F\u266f',
        pitch: 6,
        role: 'mediant',
        triad: 'F\u266fm',
        notes: 'F\u266f A C\u266f',
        seventh: 'F\u266fm7',
      },
      {
        degree: 4,
        note: 'G',
        pitch: 7,
        role: 'subdominant',
        triad: 'G',
        notes: 'G B D',
        seventh: 'GM7',
      },
      {
        degree: 5,
        note: 'A',
        pitch: 9,
        role: 'dominant',
        triad: 'A',
        notes: 'A C\u266f E',
        seventh: 'A7',
      },
      {
        degree: 6,
        note: 'B',
        pitch: 11,
        role: 'submediant',
        triad: 'Bm',
        notes: 'B D F\u266f',
        seventh: 'Bm7',
      },
      {
        degree: 7,
        note: 'C\u266f',
        pitch: 13,
        role: 'leading tone',
        triad: 'C\u266f\u00b0',
        notes: 'C\u266f E G',
        seventh: 'C\u266f\u00f87',
      },
    ]);
  });

  test('stacks the harmonic minor, so its tonic and its mediant take a major seventh', () => {
    expect(keyTable(A_MINOR).map((each) => each.triad)).toEqual([
      'Am',
      'B\u00b0',
      'C+',
      'Dm',
      'E',
      'F',
      'G\u266f\u00b0',
    ]);
    expect(keyTable(A_MINOR).map((each) => each.seventh)).toEqual([
      'AmM7',
      'B\u00f87',
      'C+M7',
      'Dm7',
      'E7',
      'FM7',
      'G\u266f\u00b07',
    ]);
    expect(keyTable(A_MINOR).map((each) => each.notes)).toEqual([
      'A C E',
      'B D F',
      'C E G\u266f',
      'D F A',
      'E G\u266f B',
      'F A C',
      'G\u266f B D',
    ]);
  });

  test('spells one note per letter, so a deep signature keeps every letter once', () => {
    expect(keyTable({ tick: 0, sharps: -7, mode: 0 }).map((each) => each.note)).toEqual([
      'C\u266d',
      'D\u266d',
      'E\u266d',
      'F\u266d',
      'G\u266d',
      'A\u266d',
      'B\u266d',
    ]);
  });

  test('counts the signature and names the key that shares it', () => {
    expect(signatureOf(D_MAJOR)).toEqual({ count: 2, notes: ['F\u266f', 'C\u266f'] });
    expect(signatureOf({ tick: 0, sharps: -3, mode: 0 })).toEqual({
      count: 3,
      notes: ['B\u266d', 'E\u266d', 'A\u266d'],
    });
    expect(signatureOf(C_MAJOR)).toEqual({ count: 0, notes: [] });
    expect(keyName(relativeOf(D_MAJOR))).toBe('B minor');
    expect(keyName(relativeOf({ tick: 0, sharps: -3, mode: 0 }))).toBe('C minor');
    expect(keyName(relativeOf(C_MAJOR))).toBe('A minor');
    expect(keyName(relativeOf(A_MINOR))).toBe('C major');
  });

  test('names the key on the same tonic in the other mode', () => {
    expect(parallelOf(D_MAJOR)).toEqual({ tick: 0, sharps: -1, mode: 1 });
    expect(keyName(parallelOf(D_MAJOR))).toBe('D minor');
    expect(parallelOf(A_MINOR)).toEqual({ tick: 0, sharps: 3, mode: 0 });
    expect(keyName(parallelOf(A_MINOR))).toBe('A major');
    expect(parallelOf(C_MAJOR)).toEqual({ tick: 0, sharps: -3, mode: 1 });
    expect(keyName(parallelOf(C_MAJOR))).toBe('C minor');
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
      { onsetIndex: 0, tick: 0, measureIndex: 0, absolute: 'C', degree: '1', root: 0, tones: [0, 4, 7] },
      { onsetIndex: 1, tick: BAR, measureIndex: 1, absolute: 'Dm', degree: '2m', root: 2, tones: [2, 5, 9] },
    ]);
  });

  test('an event carries its tones from the template, the root first', () => {
    const events = analyzeHarmony(scoreOf([[55, 59, 62, 65]]));
    expect(names(events)).toEqual(['G7 5⁷']);
    expect(events[0]!.tones).toEqual([7, 11, 2, 5]);
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
    // No template, so the root stands alone.
    expect(analyzeHarmony(score)[0]!.tones).toEqual([0]);
  });

  test('the kind gives the tones, and a slash bass adds none', () => {
    const score = scoreOf([[62, 65, 69], [67, 71, 74]], C_MAJOR, [
      symbol(0, 'Dm7', 2, ChordSymbolEnum.minorseventh),
      symbol(BAR, 'G/D', 7, ChordSymbolEnum.major, 2),
    ]);
    expect(analyzeHarmony(score).map((e) => [e.root, e.tones])).toEqual([
      [2, [2, 5, 9, 0]],
      [7, [7, 11, 2]],
    ]);
  });
});

describe('the weight of a chord tone', () => {
  test('the root leads, then the third, then the seventh, and the rest weigh alike', () => {
    expect(toneWeight(0)).toBe(1);
    expect([3, 4].map(toneWeight)).toEqual([0.75, 0.75]);
    expect([9, 10, 11].map(toneWeight)).toEqual([0.65, 0.65, 0.65]);
    expect([6, 7, 8].map(toneWeight)).toEqual([0.5, 0.5, 0.5]);
    expect([1, 2, 5].map(toneWeight)).toEqual([0.5, 0.5, 0.5]);
  });
});
