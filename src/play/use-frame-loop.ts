import { useEffect, useRef } from 'react';

/**
 * The one animation frame loop of the play screen: the engine advances, then the sheet and the lane
 * draw the same tick. The delta is capped, so a hidden tab or a sleeping machine never has its gap
 * replayed in one step.
 */
export function useFrameLoop(onFrame: (deltaMs: number, now: number) => void): void {
  const latest = useRef(onFrame);
  latest.current = onFrame;

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const delta = now - last;
      last = now;
      latest.current(Math.min(delta, 100), now);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
}
