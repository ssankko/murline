import { useSyncExternalStore } from 'react';

const query = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

/** Set once the user pins a theme with the `d` key; until then the system decides. */
let pinned: boolean | null = null;

function dark(): boolean {
  return pinned ?? query.matches;
}

function subscribe(onChange: () => void): () => void {
  query.addEventListener('change', onChange);
  listeners.add(onChange);
  return () => {
    query.removeEventListener('change', onChange);
    listeners.delete(onChange);
  };
}

/** Whether the app paints on dark paper. */
export function useDark(): boolean {
  return useSyncExternalStore(subscribe, dark);
}

/** The other paper. The class pins the CSS variables against the system setting. */
export function flipTheme(): void {
  pinned = !dark();
  document.documentElement.classList.toggle('dark', pinned);
  document.documentElement.classList.toggle('light', !pinned);
  for (const notify of listeners) notify();
}
