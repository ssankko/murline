// The settings one play runs under. A piece setting falls back to the defaults here and to nothing
// else; that resolution happens where a play is started, never inside the engine.

import { clamp } from '@/lib/utils';
import type { Hand } from '@/score/types';

export type TempoMode = 'percent' | 'bpm';

/** The span each tempo mode may be set to: percent of the written marks, or a flat quarter BPM. */
export const TEMPO_RANGE: Record<TempoMode, [min: number, max: number]> = {
  percent: [25, 200],
  bpm: [40, 240],
};

/** The tempo as a player reads it: a quarter-note BPM, or a percent of the written marks. */
export function tempoLabel(mode: TempoMode, value: number): string {
  return mode === 'bpm' ? `♩ = ${value}` : `${value} %`;
}

/**
 * Which way each tempo key steps. Shift+= types `+` and Shift+- types `_`, so the handlers read
 * `event.code` rather than the character.
 */
export const TEMPO_KEYS: Record<string, 1 | -1 | undefined> = {
  Equal: 1,
  NumpadAdd: 1,
  Minus: -1,
  NumpadSubtract: -1,
};

/**
 * The tempo one key press away: the next multiple of 5 in `direction`, or one unit with `fine`,
 * held inside the mode's range. In BPM mode the same rule reads the BPM number.
 */
export function stepTempo(
  value: number,
  direction: 1 | -1,
  fine: boolean,
  mode: TempoMode,
): number {
  const next = fine
    ? value + direction
    : direction > 0
      ? Math.floor(value / 5) * 5 + 5
      : Math.ceil(value / 5) * 5 - 5;
  return clamp(next, ...TEMPO_RANGE[mode]);
}

/** Flow runs the cursor at tempo whatever the player does; Wait stops it at every unsatisfied Onset. */
export type PlayMode = 'flow' | 'wait';

/** Which hand the play expects. The other hand's notes are context only. */
export type HandsSetting = 'both' | 'left' | 'right';

/**
 * The Inactive hand: the hand not selected while the setting names one. Its notes are context
 * only, so nothing expects them, grades them, requires them or blocks on them.
 */
export function isInactiveHand(hands: HandsSetting, hand: Hand): boolean {
  return hands !== 'both' && hands !== hand;
}

/** Where the inactive hand's loudness comes from: the score's own dynamics, or the player's hands. */
export type InactiveHandVelocity = 'score' | 'follow';

/** The span the inactive hand's level may be set to, in percent. */
export const INACTIVE_HAND_LEVEL: [min: number, max: number] = [10, 150];

/** "piece" spans the piece's own range; a number is that many keys; "custom" uses lo and hi. */
export type KeyboardPreset = 'piece' | 25 | 49 | 61 | 76 | 88 | 'custom';

export interface PlaySettings {
  tempoMode: TempoMode;
  /** Percent of every written tempo mark, or a flat quarter-note BPM, inside `TEMPO_RANGE`. */
  tempoValue: number;
  hands: HandsSetting;
  /** Whether the inactive hand sounds itself, softer, as the clock passes its notes. */
  inactiveHandSounds: boolean;
  /** Which loudness the inactive hand plays at: the written dynamics, or the player's own strikes. */
  inactiveHandVelocity: InactiveHandVelocity;
  /** Percent of that loudness the inactive hand sounds at, inside `INACTIVE_HAND_LEVEL`. */
  inactiveHandLevel: number;
  mode: PlayMode;
  metronome: boolean;
  /** Bars of count-in before motion starts. The toolbar writes 0 or 1; the engine counts any. */
  countInBars: number;
  /** Whether the Section, or the whole piece without one, wraps instead of ending. */
  loop: boolean;
  /** The Section as measure indices, both ends inside it. Either one null is no Section. */
  sectionFrom: number | null;
  sectionTo: number | null;
  keyboardPreset: KeyboardPreset;
  keyboardLo: number;
  keyboardHi: number;
  /** Half-width of the span around an Onset in which a strike counts for it, in milliseconds. */
  matchingWindowMs: number;
  /** How far apart the first and last strike of one chord may be, in milliseconds. */
  togethernessMs: number;

  // Grade knobs. Always global, never per piece, so two grades of one piece stay comparable.

  /** Timing: full marks up to this offset in milliseconds, nothing left at `timingZeroMs`. */
  timingFlatMs: number;
  timingZeroMs: number;
  /** Velocity: full marks up to this distance from the ideal, nothing left at `velocityZero`. */
  velocityFlat: number;
  velocityZero: number;
  /** Release: full marks between the two flat ratios, nothing left outside the two zero ratios. */
  releaseFlatLo: number;
  releaseFlatHi: number;
  releaseZeroLo: number;
  releaseZeroHi: number;
  /** What each curve is worth in a note's grade. Grade normalises them. */
  weightTiming: number;
  weightVelocity: number;
  weightRelease: number;
}

export const DEFAULT_PLAY_SETTINGS: PlaySettings = {
  tempoMode: 'percent',
  tempoValue: 100,
  hands: 'both',
  inactiveHandSounds: false,
  inactiveHandVelocity: 'follow',
  inactiveHandLevel: 80,
  mode: 'flow',
  metronome: false,
  countInBars: 0,
  loop: false,
  sectionFrom: null,
  sectionTo: null,
  keyboardPreset: 'piece',
  keyboardLo: 21,
  keyboardHi: 108,
  matchingWindowMs: 150,
  togethernessMs: 250,
  timingFlatMs: 25,
  timingZeroMs: 150,
  velocityFlat: 8,
  velocityZero: 16,
  releaseFlatLo: 0.5,
  releaseFlatHi: 1.3,
  releaseZeroLo: 0.2,
  releaseZeroHi: 2,
  weightTiming: 0.7,
  weightVelocity: 0.1,
  weightRelease: 0.2,
};
