// Whether the system asks for less motion. Every animation of the play screen reads this; the CSS
// ones answer it through a `prefers-reduced-motion` media query instead.

/** True while macOS Reduce motion is on, which makes every state change instant. */
export function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
