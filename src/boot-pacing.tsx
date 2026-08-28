// The boot log's pace and entrance: a line that lands holds the screen alone for a beat before
// the next appears, and every line that was not already on screen rises in. Pacing delays only
// what the log shows, never the boot itself.

import { EASE_CURVE, reducedMotion } from '@/look/motion';
import { useEffect, useRef, useState } from 'react';

/** How long a landed line holds the screen alone before the next one may appear. */
export const BEAT_MS = 150;
/** How long a line's entrance takes. */
export const ENTRANCE_MS = 150;

/**
 * The prefix of `lines` the log shows, one line longer per beat, and whether every line has both
 * appeared and held the screen for its own beat. The count ticks one past the lines, so the last
 * line is drawn a beat before `drained`; the slice keeps what is shown to the lines there are.
 * The first line skips its beat: index.html paints it before React mounts, so it is already on
 * screen.
 */
export function usePacedLines<T>(lines: T[], beatMs: number): { shown: T[]; drained: boolean } {
  const [count, setCount] = useState(() => Math.min(1, lines.length));
  useEffect(() => {
    if (count > lines.length) return;
    const timer = setTimeout(() => setCount(count + 1), beatMs);
    return () => clearTimeout(timer);
  }, [count, lines.length, beatMs]);
  return { shown: lines.slice(0, count), drained: count > lines.length };
}

/** One line of the log. A line that was not on screen before rises in, unless motion is turned down. */
export function LogLine({ text, enters }: { text: string; enters: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!enters || reducedMotion() || !ref.current) return;
    ref.current.animate(
      [
        { opacity: 0, transform: 'translateY(4px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      { duration: ENTRANCE_MS, easing: EASE_CURVE },
    );
  }, [enters]);
  return <span ref={ref}>{text}</span>;
}
