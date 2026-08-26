// The banner slot at the top of the library list holds one dismissable notice at a time. It lives
// outside React so a screen that is closing, such as a play that could not open its piece, can
// leave its message behind for the library page.

import { useSyncExternalStore } from 'react';

let notice: string | null = null;
const listeners = new Set<() => void>();

/** Puts one notice in the banner slot, or clears it with null. Extra lines follow a newline. */
export function setNotice(text: string | null): void {
  notice = text;
  for (const listen of listeners) listen();
}

/** The notice to show and the way to dismiss it. */
export function useNotice(): [string | null, () => void] {
  const text = useSyncExternalStore(subscribe, () => notice);
  return [text, () => setNotice(null)];
}

function subscribe(listen: () => void): () => void {
  listeners.add(listen);
  return () => {
    listeners.delete(listen);
  };
}
