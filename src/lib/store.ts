/** A value held outside React: `set` broadcasts to every listener `subscribe` has added. */
export function makeStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T): void {
      value = next;
      for (const listen of listeners) listen();
    },
    subscribe(listen: () => void): () => void {
      listeners.add(listen);
      return () => {
        listeners.delete(listen);
      };
    },
  };
}
