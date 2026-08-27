import { TICKS_PER_QUARTER, type ChordEvent } from '@/score/types';
import { describe, expect, test } from 'vitest';
import {
  beatsBefore,
  bounceAt,
  burnAt,
  chordsAt,
  chordsOf,
  glideLeft,
  jumpOf,
  lerpRect,
  popAt,
  pulseAt,
  slotRect,
  throughWrap,
  zoomLookahead,
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

  test('the row after the next chord counts from that chord, not from the clock', () => {
    const [, next, after] = chordsAt(chordsOf(HARMONY, WALK), 0);
    expect(glyphs(next!.tick, after!.tick)).toBe('|..');
    // Counted from the clock it would carry the beats before the next chord as well.
    expect(glyphs(0, after!.tick)).toBe('|..|..');
  });
});

describe('the lookahead under a pinch', () => {
  /** The pinch delta that halves the beats in view, from the rate the lane zooms at. */
  const HALF = Math.LN2 / 0.005;

  test('halves as the fingers spread and doubles as they close', () => {
    expect(zoomLookahead(8, -HALF)).toBeCloseTo(4);
    expect(zoomLookahead(8, HALF)).toBeCloseTo(16);
  });

  test('stops at the ends of the span the gear offers', () => {
    expect(zoomLookahead(2, -10 * HALF)).toBe(1);
    expect(zoomLookahead(30, 10 * HALF)).toBe(32);
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

describe('the view under a jump of the clock', () => {
  // A frame of motion at this tempo cannot carry the clock more than a fiftieth of a quarter.
  const REACH = Q / 50;

  test('a seek holds the lane still by taking its whole jump', () => {
    expect(jumpOf(0, 4 * Q, REACH, true, false)).toBe(-4 * Q);
    expect(jumpOf(4 * Q, 0, REACH, true, false)).toBe(4 * Q);
  });

  test('a jump no frame could have run is a seek even with the notes left open', () => {
    expect(jumpOf(0, 4 * Q, REACH, false, false)).toBe(-4 * Q);
  });

  test('motion inside one frame of time moves the view with the clock', () => {
    expect(jumpOf(0, REACH / 2, REACH, false, false)).toBe(0);
  });

  test('a loop wrap moves the view with the clock, however far it went back', () => {
    expect(jumpOf(12 * Q, 0, REACH, true, true)).toBe(0);
  });
});

describe('the glide back onto the clock', () => {
  test('holds the whole offset at the start and none of it at the end', () => {
    expect(glideLeft(0)).toBe(1);
    expect(glideLeft(1)).toBe(0);
    expect(glideLeft(2)).toBe(0);
  });

  test('eases in and out, so it stands at half way at half time', () => {
    expect(glideLeft(0.5)).toBeCloseTo(0.5);
    // Slow at both ends: the first quarter and the last cover the same little ground.
    expect(1 - glideLeft(0.25)).toBeCloseTo(glideLeft(0.75));
    expect(glideLeft(0.25)).toBeGreaterThan(glideLeft(0.5));
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

/** The share of the pop the number spends growing, and the share of a burn its collapse takes. */
const RISE = 0.3;
const COLLAPSE = 0.18;

describe('the count-in number as its beat is struck', () => {
  test('breathes out and settles back to its own size', () => {
    expect(popAt(0)).toBe(1);
    expect(popAt(RISE)).toBeCloseTo(1.45);
    expect(popAt(0.99)).toBeCloseTo(1);
    expect(popAt(RISE / 2)).toBeGreaterThan(1);
    expect(popAt(RISE / 2)).toBeLessThan(popAt(RISE));
  });

  test('is its own size outside its time, whatever the clock hands over', () => {
    expect(popAt(-5)).toBe(1);
    expect(popAt(5)).toBe(1);
    expect(popAt(NaN)).toBe(1);
  });
});

describe('a countdown glyph burning up on its beat', () => {
  test('rests whole and ends as nothing', () => {
    expect(burnAt(1)).toEqual({ alpha: 1, scale: 1, heat: 0 });
    expect(burnAt(2)).toEqual({ alpha: 1, scale: 1, heat: 0 });
    expect(burnAt(NaN)).toEqual({ alpha: 1, scale: 1, heat: 0 });
    expect(burnAt(0)).toEqual({ alpha: 0, scale: 0, heat: 1 });
  });

  test('flares to its widest at full heat before it collapses', () => {
    const flare = burnAt(COLLAPSE);
    expect(flare).toEqual({ alpha: 1, scale: 1.3, heat: 1 });
    // Half way through the collapse it is half the flare and half gone.
    const dying = burnAt(COLLAPSE / 2);
    expect(dying.alpha).toBeCloseTo(0.5);
    expect(dying.scale).toBeCloseTo(0.65);
  });

  test('grows and heats up all the way through the burn', () => {
    expect(burnAt(0.8).scale).toBeGreaterThan(1);
    expect(burnAt(0.8).scale).toBeLessThan(burnAt(0.5).scale);
    expect(burnAt(0.8).heat).toBeLessThan(burnAt(0.5).heat);
    expect(burnAt(0.5).alpha).toBe(1);
  });
});
