import { useSyncExternalStore } from 'react';

/** System reads `prefers-color-scheme`; the other two pin the paper against it. */
export type Theme = 'system' | 'light' | 'dark';

const query = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

let theme: Theme = 'system';

function dark(): boolean {
  return theme === 'system' ? query.matches : theme === 'dark';
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

/** The theme setting as it stands, for the control that shows it. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => theme);
}

/** Paints the app in a theme. The class pins the CSS variables; System takes both classes off. */
export function setTheme(next: Theme): void {
  theme = next;
  const root = document.documentElement.classList;
  root.toggle('dark', next === 'dark');
  root.toggle('light', next === 'light');
  for (const notify of listeners) notify();
}

/** The other paper, as an explicit setting. Returns what to store. */
export function flipTheme(): Theme {
  const next = dark() ? 'light' : 'dark';
  setTheme(next);
  return next;
}
