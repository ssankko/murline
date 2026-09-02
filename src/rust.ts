// What the window's half of the seam still needs by hand. Everything else is in `src/bindings.ts`,
// which follows the Rust source: the commands, the events and every shape they carry.

import { events, type Refusal } from '@/bindings';

/** Whether this is a refusal from the Rust side rather than the window's own thrown `Error`. */
export function isRefusal(error: unknown): error is Refusal {
  return typeof error === 'object' && error !== null && 'kind' in error && 'text' in error;
}

/** Every event the Rust side sends, under the name the bindings give it. */
export type EventName = keyof typeof events;

/** What one event carries. */
export type EventPayload<K extends EventName> = Parameters<(typeof events)[K]['emit']>[0];

/** Listens to one event until the returned function is called. Registering is a promise and the
 * React effects that listen want a stop they can return at once. */
export function on<K extends EventName>(
  name: K,
  handler: (payload: EventPayload<K>) => void,
): () => void {
  // The listener may not be registered yet when the caller stops; the stop waits on the same
  // promise, so it takes effect whenever the registration lands. A failed one stops nothing.
  const ready = events[name]
    .listen((event) => handler(event.payload as EventPayload<K>))
    .catch(() => () => {});
  return () => void ready.then((unlisten) => unlisten());
}
