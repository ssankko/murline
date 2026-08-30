// The velocity remap's arithmetic, kept clear of React and the settings so that anything can read
// it: the plot draws with it, and the grading tests hold it up against what a grade sees.

/** How far each end of the curve slider bends the exponent, either side of the straight line. */
const SPAN = 2.5;

/** The exponent a slider position asks for: soft at the left, straight in the middle, hard right. */
export function curveOf(position: number): number {
  return Math.round(SPAN ** ((50 - position) / 50) * 1000) / 1000;
}

/** Where an exponent sits on that slider. */
export function positionOf(curve: number): number {
  return Math.round(50 - (50 * Math.log(curve)) / Math.log(SPAN));
}

/**
 * Input velocity to output velocity. It is the same mapping the engine applies in `curved`
 * (`src-tauri/src/audio/mac.rs`): velocity 1 lands exactly on `min`, velocity 127 exactly on `max`,
 * and the exponent bends the path between them. Nothing is clamped, because every input already
 * lands inside the two ends. Velocity 0 stays 0, a note on at zero velocity being a note off.
 *
 * This is the velocity the whole app works in. The instrument is played at it and the strike the
 * webview grades carries it, so a grade reads the output velocity, not what the keyboard sent.
 */
export function curved(velocity: number, min: number, max: number, curve: number): number {
  if (velocity <= 0) return 0;
  return Math.round(min + (max - min) * ((velocity - 1) / 126) ** curve);
}
