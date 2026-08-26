import { useSyncExternalStore } from 'react';

const query = window.matchMedia('(prefers-color-scheme: dark)');

/** Whether the app paints on dark paper. The system setting is the only mechanism. */
export function useDark(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => query.matches,
  );
}
