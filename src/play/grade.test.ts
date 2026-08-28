import { noteGrade, playGrade, releaseGrade, timingGrade, velocityGrade } from '@/play/grade';
import type { NoteStrike } from '@/play/grade';
import { curved } from '@/audio/curve';
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

  // The remap is not the sound's alone: `src-tauri/src/midi/mac.rs` puts it on the strike the
  // webview is told about, so what reaches a grade is the output velocity. Grading a key press is
  // therefore grading the calibration the player set, which is the point of setting it.
  test('a strike reaches a grade already remapped', () => {
    // What the keyboard sent, and what the app works in once the remap has had it.
    const pressed = 80;
    const struck = curved(pressed, 30, 90, 1.6);
    expect(struck).not.toBe(pressed);

    // The grade is the remapped strike's, not the key press's, and the two differ.
    expect(velocityGrade(struck, struck, s)).toBe(100);
    expect(velocityGrade(struck, pressed, s)).toBeLessThan(100);

    // Different calibrations put the same key press on different grades against one ideal.
    const grades = [
      [1, 127, 1.6],
      [30, 90, 0.5],
      [100, 127, 2.5],
    ].map(([min, max, curve]) => velocityGrade(curved(pressed, min!, max!, curve!), 80, s));
    expect(new Set(grades).size).toBeGreaterThan(1);
  });

  test('the remap pins the lightest strike to the minimum and the hardest to the maximum', () => {
    for (const [min, max, curve] of [
      [1, 127, 1.6],
      [30, 90, 0.5],
      [64, 64, 2.5],
    ]) {
      expect(curved(1, min!, max!, curve!)).toBe(min);
      expect(curved(127, min!, max!, curve!)).toBe(max);
    }
    // A note on at zero velocity is a note off, so it is left where it is.
    expect(curved(0, 30, 90, 1.6)).toBe(0);
  });

  // The remap is applied once, by the engine, before the strike is emitted. A second application
  // anywhere on the webview side would land somewhere else, which is what this pins.
  test('a remapped strike put through the remap again is a different number', () => {
    const once = curved(80, 30, 90, 1.6);
    expect(curved(once, 30, 90, 1.6)).not.toBe(once);
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
