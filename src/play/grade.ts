// Grade: what a Performance earns. Pure arithmetic over what the engine collected during the run,
// so a weight or a window changed later never touches a grade already stored.

import type { PlaySettings } from '@/play/settings';

/** What one matched note left for Grade. */
export interface NoteStrike {
  /** Strike minus expected, in milliseconds; late is positive. */
  timingMs: number;
  velocity: number;
  /** The Score's ideal velocity for the note. */
  ideal: number;
  /** Held ÷ written at play tempo, or null while the key was still down when the play stopped. */
  release: number | null;
}

/** The numbers one finished performance leaves: the headline, then the breakdown behind it. */
export interface PlayGrade {
  /** 0 to 100: the per-note grades over the expected notes and the extras together. */
  grade: number;
  expected: number;
  matched: number;
  extras: number;
  /** Means of the three per-note curves over the matched notes, each 0 to 100. */
  meanTiming: number;
  /** Null for a Score with no dynamics mark, which says nothing about how loud to play. */
  meanVelocity: number | null;
  meanRelease: number;
}

/** 100 up to `flat`, falling in a straight line to 0 at `zero`. */
function ramp(distance: number, flat: number, zero: number): number {
  if (distance <= flat) return 100;
  if (distance >= zero || zero <= flat) return 0;
  return (100 * (zero - distance)) / (zero - flat);
}

/** How close the strike was to the note's own moment. Symmetric: early costs what late costs. */
export function timingGrade(timingMs: number, s: PlaySettings): number {
  return ramp(Math.abs(timingMs), s.timingFlatMs, s.timingZeroMs);
}

/** How loud the strike was against the Score's ideal, the global offset put on the strike first. */
export function velocityGrade(velocity: number, ideal: number, s: PlaySettings): number {
  return ramp(Math.abs(velocity + s.velocityOffset - ideal), s.velocityFlat, s.velocityZero);
}

/** How long the key was held against the written duration. Articulation marks are not read. */
export function releaseGrade(release: number, s: PlaySettings): number {
  const { releaseFlatLo: lo, releaseFlatHi: hi } = s;
  if (release < lo) return ramp(lo - release, 0, lo - s.releaseZeroLo);
  if (release > hi) return ramp(release - hi, 0, s.releaseZeroHi - hi);
  return 100;
}

/**
 * The weights the three curves carry for one note. A Score with no dynamics mark says nothing about
 * loudness, and a key still held says nothing about release, so those weights go to the rest.
 */
function weightsOf(strike: NoteStrike, s: PlaySettings, hasDynamics: boolean): number[] {
  return [
    Math.max(0, s.weightTiming),
    hasDynamics ? Math.max(0, s.weightVelocity) : 0,
    strike.release === null ? 0 : Math.max(0, s.weightRelease),
  ];
}

/** One note's grade, 0 to 100. The weights are normalised, whatever the settings hold. */
export function noteGrade(strike: NoteStrike, s: PlaySettings, hasDynamics: boolean): number {
  const grades = [
    timingGrade(strike.timingMs, s),
    velocityGrade(strike.velocity, strike.ideal, s),
    strike.release === null ? 0 : releaseGrade(strike.release, s),
  ];
  const weights = weightsOf(strike, s, hasDynamics);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // Weights that add up to nothing leave timing, the one curve every note always has.
  if (total <= 0) return grades[0]!;
  return grades.reduce((sum, grade, i) => sum + grade * weights[i]!, 0) / total;
}

/**
 * The grade of one play: `notes` holds one entry per expected note whose matching window closed
 * before the stop, null where the note was missed. Extras only enlarge the denominator. A play with
 * no closed window has no grade.
 */
export function playGrade(
  notes: (NoteStrike | null)[],
  extras: number,
  s: PlaySettings,
  hasDynamics: boolean,
): PlayGrade | null {
  if (notes.length === 0) return null;
  let sum = 0;
  let timing = 0;
  let velocity = 0;
  let release = 0;
  let matched = 0;
  let released = 0;
  for (const strike of notes) {
    if (!strike) continue;
    matched++;
    sum += noteGrade(strike, s, hasDynamics);
    timing += timingGrade(strike.timingMs, s);
    velocity += velocityGrade(strike.velocity, strike.ideal, s);
    if (strike.release !== null) {
      release += releaseGrade(strike.release, s);
      released++;
    }
  }
  const mean = (total: number, count: number) => (count > 0 ? Math.round(total / count) : 0);
  return {
    grade: Math.round(sum / (notes.length + extras)),
    expected: notes.length,
    matched,
    extras,
    meanTiming: mean(timing, matched),
    meanVelocity: hasDynamics ? mean(velocity, matched) : null,
    meanRelease: mean(release, released),
  };
}
