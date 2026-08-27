/** True while the system asks for less motion, which makes every state change instant. */
export function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}
