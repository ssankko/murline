import {
  TICKS_PER_QUARTER,
  playedSeconds,
  type Measure,
  type Note,
  type Onset,
  type Score,
} from '@/score/types';
import { expect, test } from 'vitest';
import { barAt, barSeconds, previewBars, previewNotes } from './preview';

const BAR = 4 * TICKS_PER_QUARTER;

function note(midi: number, durationTicks: number, over: Partial<Note> = {}): Note {
  return {
    midi,
    staff: 0,
    hand: 'right',
    onsetTick: 0,
    durationTicks,
    tiedFrom: false,
    grace: false,
    strikeable: true,
    velocity: 100,
    measureIndex: 0,
    source: undefined as never,
    ...over,
  };
}

function measure(index: number): Measure {
  return {
    index,
    number: index + 1,
    startTick: index * BAR,
    durationTicks: BAR,
    beatsPerBar: 4,
    beatUnit: 4,
  };
}

/**
 * Two bars of 4/4, the first played again by a repeat, at 60 BPM until the second bar doubles it.
 * Bar 1 holds a tie chain over the half-bar line, a grace note and a left hand; bar 2 is softer.
 */
function scoreWithRepeat(): Score {
  const onsets: Onset[] = [
    {
      tick: 0,
      measureIndex: 0,
      notes: [
        note(60, 2 * TICKS_PER_QUARTER),
        note(48, BAR, { staff: 1, hand: 'left' }),
        note(62, 0, { grace: true }),
      ],
    },
    {
      tick: 2 * TICKS_PER_QUARTER,
      measureIndex: 0,
      // The tie continuation of the note struck at tick 0, and a note of its own beside it.
      notes: [
        note(60, TICKS_PER_QUARTER, { tiedFrom: true, strikeable: false }),
        note(62, 2 * TICKS_PER_QUARTER),
      ],
    },
    { tick: BAR, measureIndex: 1, notes: [note(64, BAR, { velocity: 64, measureIndex: 1 })] },
  ];
  return {
    title: 'repeat',
    composer: 'test',
    partName: 'Piano',
    partCount: 1,
    staffCount: 2,
    onsets,
    playOrder: [
      { onsetIndex: 0, tick: 0 },
      { onsetIndex: 1, tick: 2 * TICKS_PER_QUARTER },
      { onsetIndex: 2, tick: BAR },
      { onsetIndex: 0, tick: 2 * BAR },
      { onsetIndex: 1, tick: 2 * BAR + 2 * TICKS_PER_QUARTER },
    ],
    totalTicks: 3 * BAR,
    tempoMap: [
      { tick: 0, bpm: 60 },
      { tick: BAR, bpm: 120 },
    ],
    hasTempo: true,
    constantTempo: false,
    hasDynamics: true,
    measures: [measure(0), measure(1)],
    keys: [],
    chords: [],
    harmony: [],
  };
}

test('the note list follows the repeat, drops graces and ties, and reads the tempo map', () => {
  expect(previewNotes(scoreWithRepeat())).toEqual([
    { midi: 60, velocity: 100, on: 0, off: 2 },
    { midi: 48, velocity: 100, on: 0, off: 4 },
    { midi: 62, velocity: 100, on: 2, off: 4 },
    // The second bar is written at twice the tempo, so it takes two seconds, not four.
    { midi: 64, velocity: 64, on: 4, off: 6 },
    { midi: 60, velocity: 100, on: 6, off: 8 },
    { midi: 48, velocity: 100, on: 6, off: 10 },
    { midi: 62, velocity: 100, on: 8, off: 10 },
  ]);
});

test('the piece is as long as its last note off, by the one walk both readings take', () => {
  expect(playedSeconds(scoreWithRepeat())).toBe(10);
});

test('a bar opens once for every pass of the repeat, and a click seeks to its first', () => {
  const bars = previewBars(scoreWithRepeat());
  expect(bars).toEqual([
    { measureIndex: 0, seconds: 0 },
    { measureIndex: 1, seconds: 4 },
    { measureIndex: 0, seconds: 6 },
  ]);

  expect(barAt(bars, 0)).toBe(0);
  expect(barAt(bars, 3.9)).toBe(0);
  expect(barAt(bars, 4)).toBe(1);
  expect(barAt(bars, 7)).toBe(0);
  expect(barSeconds(bars, 1)).toBe(4);
  expect(barSeconds(bars, 0)).toBe(0);
});
