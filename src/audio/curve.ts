// The velocity curve's arithmetic, kept clear of React and the database so that anything can read
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
 * The velocity the instrument hears. It is the same mapping the engine applies in `curved`
 * (`src-tauri/src/audio/mac.rs`): the lightest playable strike lands on the softest note's volume,
 * the hardest reaches full, and the exponent bends the path between.
 *
 * This is the sound's velocity alone. What a grade reads is the velocity the keyboard sent, which
 * nothing here touches.
 */
export function curved(velocity: number, floor: number, curve: number): number {
  if (velocity <= 0) return 0;
  const lowest = 1 + Math.round((126 * Math.min(100, Math.max(0, floor))) / 100);
  return Math.round(lowest + (127 - lowest) * ((velocity - 1) / 126) ** curve);
}
