// The keys the Sound tab's two plots draw. Both want the same thing: what is under the hands right
// now, not merely the last key struck, so a chord reads as a chord. Kept clear of React so the
// plots and their tests can both work it out.

import type { StrikeEvent } from '@/play/engine';

/** One key the plots are drawing. */
export interface Sounding {
  midi: number;
  /** The output velocity it was struck at, carried over the key coming up, which sends none. */
  velocity: number;
  /** False once the key has come up, which is the note dying away rather than gone. */
  on: boolean;
  /** When the key went down, or came up, on the `performance.now()` clock. */
  at: number;
  /** How long the key was held, in milliseconds, once it has come up. Zero while it is down. */
  held: number;
}

/** How long a key that has come up is kept, which is the longest release the envelope offers. */
const LINGER = 4000;

/** The keys sounding after one more strike, dropping any that came up long enough ago to be gone. */
export function sounded(all: Sounding[], event: StrikeEvent, at: number): Sounding[] {
  const was = all.find((one) => one.midi === event.midi);
  const rest = all.filter(
    (one) => one.midi !== event.midi && (one.on || at - one.at < LINGER),
  );
  return [
    ...rest,
    {
      midi: event.midi,
      velocity: event.on ? event.velocity : (was?.velocity ?? event.velocity),
      on: event.on,
      at,
      held: event.on ? 0 : at - (was?.at ?? at),
    },
  ];
}
