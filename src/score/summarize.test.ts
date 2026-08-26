import { expect, test } from 'vitest';
import { summarize } from './summarize';
import { ScoreError, TICKS_PER_QUARTER, type Note, type Onset, type Score } from './types';

// A hand-written Score: two bars of two quarter notes at 60 BPM, so the arithmetic is checkable by
// eye. The OSMD references only matter to the sheet, so the test does without them.
function note(midi: number, onsetTick: number, over: Partial<Note> = {}): Note {
  return {
    midi,
    staff: 0,
    hand: 'right',
    voice: 1,
    onsetTick,
    durationTicks: TICKS_PER_QUARTER,
    tieStart: false,
    tiedFrom: false,
    grace: false,
    strikeable: true,
    velocity: 80,
    measureIndex: Math.floor(onsetTick / (4 * TICKS_PER_QUARTER)),
    source: undefined as unknown as Note['source'],
    ...over,
  };
}

function scoreOf(onsetNotes: Note[][]): Score {
  const onsets: Onset[] = onsetNotes.map((notes, i) => ({
    tick: i * TICKS_PER_QUARTER,
    measureIndex: 0,
    notes,
    timestamp: undefined as unknown as Onset['timestamp'],
  }));
  return {
    title: '',
    composer: '',
    partName: '',
    partCount: 3,
    staffCount: 2,
    onsets,
    playOrder: onsets.map((_, i) => ({ onsetIndex: i, tick: i * TICKS_PER_QUARTER })),
    totalTicks: onsets.length * TICKS_PER_QUARTER,
    tempoMap: [{ tick: 0, bpm: 60 }],
    hasTempo: true,
    constantTempo: true,
    measures: [
      {
        index: 0,
        number: 1,
        startTick: 0,
        durationTicks: 4 * TICKS_PER_QUARTER,
        beatsPerBar: 4,
        beatUnit: 4,
      },
    ],
    keys: [{ measureIndex: 0, measureNumber: 1, sharps: -3, mode: 1 }],
    chords: [],
  };
}

test('the index carries every fact the piece row stores', () => {
  const score = scoreOf([[note(60, 0), note(72, 0)], [note(48, TICKS_PER_QUARTER)]]);

  expect(summarize(score, 'Chopin - Nocturne.musicxml')).toEqual({
    title: 'Chopin - Nocturne',
    composer: 'Chopin - Nocturne',
    measureCount: 1,
    durationS: 2,
    midiLo: 48,
    midiHi: 72,
    hasTempo: true,
    constantTempo: true,
    keySharps: -3,
    keyMode: 'minor',
    partCount: 3,
    partName: 'Part 1',
  });
});

test('the title and composer of the file win over the file name', () => {
  const score = { ...scoreOf([[note(60, 0)]]), title: 'Nocturne', composer: 'Chopin' };
  const index = summarize(score, 'whatever.musicxml');

  expect(index.title).toBe('Nocturne');
  expect(index.composer).toBe('Chopin');
});

test('the range spans notes nobody strikes, because it is what the piece prints', () => {
  const score = scoreOf([[note(60, 0), note(96, 0, { tiedFrom: true, strikeable: false })]]);

  expect(summarize(score, 'x.musicxml').midiHi).toBe(96);
});

test('a piece of tie continuations alone cannot be indexed', () => {
  const score = scoreOf([[note(60, 0, { tiedFrom: true, strikeable: false })]]);

  expect(() => summarize(score, 'silence.musicxml')).toThrow(ScoreError);
  expect(() => summarize(score, 'silence.musicxml')).toThrow('No notes in the first part');
});
