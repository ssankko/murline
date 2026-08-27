import { TICKS_PER_QUARTER, type ChordEvent } from '@/score/types';
import { describe, expect, test } from 'vitest';
import {
  beatsBefore,
  bounceAt,
  chordsAt,
  chordsOf,
  lerpRect,
  pulseAt,
  slotRect,
  throughWrap,
} from './lane';

const Q = TICKS_PER_QUARTER;
/** Three bars of 3/4 in played time, counted in quarters. */
const BARS = [0, 1, 2].map((i) => ({
  tick: i * 3 * Q,
  number: i + 1,
  measure: i,
  beatTicks: Q,
  endTick: (i + 1) * 3 * Q,
}));

function chord(onsetIndex: number, absolute: string): ChordEvent {
  return { onsetIndex, tick: onsetIndex * Q, measureIndex: 0, absolute, degree: '1' };
}

/** Six Onsets, one per quarter, with bar 1 played again after bar 2. */
const HARMONY = [chord(0, 'C'), chord(3, 'G')];
const WALK = [
  ...[0, 1, 2, 3, 4, 5].map((i) => ({ onsetIndex: i, tick: i * Q })),
  ...[0, 1, 2].map((i) => ({ onsetIndex: i, tick: (6 + i) * Q })),
];

/** The countdown as it reads: a dot per beat, a stick where a bar opens. */
const glyphs = (playedTick: number, chordTick: number) =>
  beatsBefore(BARS, playedTick, chordTick)
    .map((glyph) => (glyph.strong ? '|' : '.'))
    .join('');

describe('the harmony in played time', () => {
  test('a repeated bar names its chords again', () => {
    expect(chordsOf(HARMONY, WALK).map((each) => [each.tick, each.event.absolute])).toEqual([
      [0, 'C'],
      [3 * Q, 'G'],
      [6 * Q, 'C'],
    ]);
  });

  test('the panel shows the chord in force and the two after it', () => {
    const chords = chordsOf(HARMONY, WALK);
    expect(chordsAt(chords, Q)).toEqual([chords[0], chords[1], chords[2]]);
    expect(chordsAt(chords, -Q)).toEqual([undefined, chords[0], chords[1]]);
    expect(chordsAt(chords, 8 * Q)).toEqual([chords[2], undefined, undefined]);
  });

  test('the loop reads the lap again past the wrap', () => {
    const chords = chordsOf(HARMONY, WALK).slice(0, 2);
    const lap = throughWrap(chords, { from: 0, to: 6 * Q }, (each, by) => ({
      ...each,
      tick: each.tick + by,
    }));
    expect(lap.map((each) => each.tick)).toEqual([0, 3 * Q, 6 * Q, 9 * Q]);
  });
});

describe('the countdown', () => {
  test('one glyph per beat left, the downbeat a stick', () => {
    // From beat 2 of bar 1 to the downbeat of bar 3.
    expect(glyphs(Q, 6 * Q)).toBe('..|..');
  });

  test('a glyph goes as its beat ends', () => {
    expect(glyphs(2 * Q, 6 * Q)).toBe('.|..');
    expect(glyphs(6 * Q, 6 * Q)).toBe('');
  });

  test('a chord on the next beat leaves one glyph', () => {
    expect(glyphs(0, Q)).toBe('|');
  });
});

test('a panel between two slots starts at the one and ends at the other', () => {
  const from = slotRect(1, 300);
  const to = slotRect(0, 300);
  expect(lerpRect(from, to, 0)).toEqual(from);
  expect(lerpRect(from, to, 1)).toEqual(to);
});

describe('the pulse at the now-line', () => {
  // The beat is a quarter, so the pulse runs out 12 % of a quarter after each beat.
  const rise = 0.12 * Q;

  test('is full on the beat and gone a short way into it', () => {
    expect(pulseAt(BARS, Q)).toEqual({ level: 1, strong: false });
    expect(pulseAt(BARS, Q + rise / 2).level).toBeCloseTo(0.5);
    expect(pulseAt(BARS, Q + rise)).toEqual({ level: 0, strong: false });
  });

  test('is strong on the beat a bar opens with', () => {
    expect(pulseAt(BARS, 3 * Q)).toEqual({ level: 1, strong: true });
    expect(pulseAt(BARS, 3 * Q + rise / 2)).toMatchObject({ strong: true });
  });

  test('is nothing outside the bars of the play', () => {
    expect(pulseAt(BARS, -Q)).toEqual({ level: 0, strong: false });
    expect(pulseAt(BARS, 99 * Q)).toEqual({ level: 0, strong: false });
  });
});

describe('the swing of a struck block', () => {
  test('is out and back inside its time, and its own size outside it', () => {
    expect(bounceAt(0)).toBe(1);
    expect(bounceAt(0.25)).toBeGreaterThan(1.1);
    expect(bounceAt(0.25)).toBeLessThan(1.2);
    expect(bounceAt(0.75)).toBeLessThan(1);
    // A clock that hands over a wild number must never scale a block by one.
    expect(bounceAt(-5)).toBe(1);
    expect(bounceAt(5)).toBe(1);
    expect(bounceAt(NaN)).toBe(1);
  });
});
