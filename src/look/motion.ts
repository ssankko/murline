/** True while the system asks for less motion, which makes every state change instant. */
export function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The timing function of every movement, held in src/index.css so CSS and JS ease alike. */
export const EASE = 'var(--ease)';

/** The same curve written out, because a Web Animations easing cannot resolve a var(). */
export const EASE_CURVE = 'cubic-bezier(0.65, 0, 0.35, 1)';

/**
 * How far through its travel a movement is `t` of the way through its time: slow away, fast
 * through the middle, slow in. The cubic `--ease` draws.
 */
export function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t ** 3 : 1 - (2 - 2 * t) ** 3 / 2;
}
