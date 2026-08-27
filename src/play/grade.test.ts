import { noteGrade, playGrade, releaseGrade, timingGrade, velocityGrade } from '@/play/grade';
import type { NoteStrike } from '@/play/grade';
import { DEFAULT_PLAY_SETTINGS, type PlaySettings } from '@/play/settings';
import { describe, expect, test } from 'vitest';

function settings(over: Partial<PlaySettings> = {}): PlaySettings {
  return { ...DEFAULT_PLAY_SETTINGS, ...over };
}

/** A note struck dead on time, at the ideal velocity, held its written length. */
function perfect(over: Partial<NoteStrike> = {}): NoteStrike {
  return { timingMs: 0, velocity: 80, ideal: 80, release: 1, ...over };
}

const s = settings();

describe('the timing curve', () => {
  test('is full inside the flat window and gone at the far window', () => {
    expect(timingGrade(0, s)).toBe(100);
    expect(timingGrade(25, s)).toBe(100);
    expect(timingGrade(-25, s)).toBe(100);
    expect(timingGrade(150, s)).toBe(0);
    expect(timingGrade(-150, s)).toBe(0);
  });

  test('falls in a straight line between them, early like late', () => {
    expect(timingGrade(87.5, s)).toBeCloseTo(50);
    expect(timingGrade(-87.5, s)).toBeCloseTo(50);
    expect(timingGrade(50, s)).toBeCloseTo(80);
  });
});

describe('the velocity curve', () => {
  test('is full inside 8 units of the ideal and gone at 16', () => {
    expect(velocityGrade(80, 80, s)).toBe(100);
    expect(velocityGrade(88, 80, s)).toBe(100);
    expect(velocityGrade(72, 80, s)).toBe(100);
    expect(velocityGrade(96, 80, s)).toBe(0);
    expect(velocityGrade(64, 80, s)).toBe(0);
    expect(velocityGrade(92, 80, s)).toBeCloseTo(50);
  });

  test('the global offset moves the strike before it meets the ideal', () => {
    expect(velocityGrade(70, 80, settings({ velocityOffset: 10 }))).toBe(100);
    expect(velocityGrade(80, 80, settings({ velocityOffset: -20 }))).toBe(0);
  });
});

describe('the release curve', () => {
  test('is full over the whole plateau and gone at both bounds', () => {
    expect(releaseGrade(0.5, s)).toBe(100);
    expect(releaseGrade(1, s)).toBe(100);
    expect(releaseGrade(1.3, s)).toBe(100);
    expect(releaseGrade(0.2, s)).toBe(0);
    expect(releaseGrade(2, s)).toBe(0);
  });

  test('falls in a straight line on each side of the plateau', () => {
    expect(releaseGrade(0.35, s)).toBeCloseTo(50);
    expect(releaseGrade(1.65, s)).toBeCloseTo(50);
  });
});

describe('one note', () => {
  test('weighs timing 0.70, velocity 0.10 and release 0.20', () => {
    // Timing gone, the other two full: 0.10 + 0.20 of the weight is left.
    expect(noteGrade(perfect({ timingMs: 200 }), s, true)).toBeCloseTo(30);
    // Velocity gone: 0.70 + 0.20 left.
    expect(noteGrade(perfect({ velocity: 120 }), s, true)).toBeCloseTo(90);
    // Release gone: 0.70 + 0.10 left.
    expect(noteGrade(perfect({ release: 4 }), s, true)).toBeCloseTo(80);
  });

  test('drops the velocity weight when the Score has no dynamics marks', () => {
    // 0.70 and 0.20 rescale to 1, so a velocity miles off the ideal costs nothing.
    expect(noteGrade(perfect({ velocity: 10 }), s, false)).toBeCloseTo(100);
    // Timing gone leaves release alone: 0.20 of 0.90.
    expect(noteGrade(perfect({ timingMs: 200, velocity: 10 }), s, false)).toBeCloseTo(200 / 9);
  });

  test('gives a key still held at the stop no release grade and shares its weight out', () => {
    expect(noteGrade(perfect({ release: null }), s, true)).toBeCloseTo(100);
    // Only timing and velocity are left, so a lost velocity costs 0.10 of 0.80.
    expect(noteGrade(perfect({ release: null, velocity: 120 }), s, true)).toBeCloseTo(87.5);
  });

  test('normalises weights that do not add up to one', () => {
    const doubled = settings({ weightTiming: 7, weightVelocity: 1, weightRelease: 2 });
    expect(noteGrade(perfect({ timingMs: 200 }), doubled, true)).toBeCloseTo(30);
  });
});

describe('the play grade', () => {
  test('divides the sum of the note grades by the expected notes and the extras', () => {
    const notes = [perfect(), perfect(), perfect(), null];
    expect(playGrade(notes, 0, s, true)).toMatchObject({
      grade: 75,
      expected: 4,
      matched: 3,
      extras: 0,
    });
    // Two extras enlarge the denominator without adding anything to the sum.
    expect(playGrade(notes, 2, s, true)).toMatchObject({ grade: 50, expected: 4, extras: 2 });
  });

  test('reads the breakdown over the matched notes only', () => {
    const grade = playGrade([perfect({ timingMs: 200 }), perfect(), null], 1, s, true)!;
    expect(grade).toMatchObject({
      expected: 3,
      matched: 2,
      extras: 1,
      meanTiming: 50,
      meanVelocity: 100,
      meanRelease: 100,
    });
  });

  test('reads mean release over the matched notes that were let go', () => {
    const grade = playGrade([perfect({ release: null }), perfect({ release: 4 })], 0, s, true)!;
    expect(grade.meanRelease).toBe(0);
    expect(grade.matched).toBe(2);
  });

  test('has no mean velocity when the Score carries no dynamics mark', () => {
    const notes = [perfect(), perfect({ velocity: 10 })];
    expect(playGrade(notes, 0, s, false)!.meanVelocity).toBeNull();
    expect(playGrade(notes, 0, s, true)!.meanVelocity).toBe(50);
  });

  test('has no grade when no window closed', () => {
    expect(playGrade([], 0, s, true)).toBeNull();
    expect(playGrade([], 5, s, true)).toBeNull();
  });
});
