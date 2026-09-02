// What version runs and what version the release page holds. It lives outside React because the
// status bar is built again on every screen, and because a version already fetched has to stay
// fetched for the rest of the run.

import { reasonOf } from '@/library/notice';
import { commands } from '@/bindings';
import { useSyncExternalStore } from 'react';

/** Where the update stands. `ready` is a version on disk, waiting for the next launch. */
type Update =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'found'; version: string }
  | { kind: 'taking'; version: string }
  | { kind: 'ready'; version: string }
  | { kind: 'failed'; why: string };

/** The version running, empty until the Rust side has said, and what waits beyond it. */
export interface Versions {
  current: string;
  update: Update;
}

/** What the tooltip over the version cell says, and over the button beside it. */
export function updateLabel({ current, update }: Versions): string {
  switch (update.kind) {
    case 'checking':
      return 'Looking for a newer version…';
    case 'found':
      return `Update available ${current} → ${update.version}`;
    case 'taking':
      return `Fetching ${update.version}…`;
    case 'ready':
      return `${update.version} is in place. Press again to start it now.`;
    case 'failed':
      return update.why;
    case 'idle':
      return `Murline ${current} is the newest there is. Click to look again.`;
  }
}

/**
 * Asks the release page what it holds. The version already fetched is not offered a second time,
 * however often this runs.
 */
export async function checkUpdate(): Promise<void> {
  const before = held.update;
  if (before.kind === 'checking' || before.kind === 'taking') return;
  set({ ...held, update: { kind: 'checking' } });
  try {
    const current = held.current || (await commands.appVersion());
    const waiting = await commands.updateCheck();
    if (before.kind === 'ready' && before.version === waiting) set({ current, update: before });
    else if (waiting) set({ current, update: { kind: 'found', version: waiting } });
    else set({ current, update: { kind: 'idle' } });
  } catch (error) {
    set({ ...held, update: { kind: 'failed', why: reasonOf(error) } });
  }
}

/** Fetches the version the check found and swaps the app on disk. Only a click calls this. */
export async function takeUpdate(): Promise<void> {
  const waiting = held.update;
  if (waiting.kind !== 'found') return;
  set({ ...held, update: { kind: 'taking', version: waiting.version } });
  try {
    await commands.updateInstall();
    set({ ...held, update: { kind: 'ready', version: waiting.version } });
  } catch (error) {
    set({ ...held, update: { kind: 'failed', why: reasonOf(error) } });
  }
}

/** Starts the app again, which is how a version already on disk takes over. Nothing comes back:
 * this window goes down with the process it belongs to. */
export function restartApp(): void {
  commands.updateRestart().catch(() => {});
}

/** The version running and the update as it stands, as one value. */
export function versions(): Versions {
  return held;
}

/** The same, for as long as the component asking is up. */
export function useVersions(): Versions {
  return useSyncExternalStore(subscribe, versions);
}

let held: Versions = { current: '', update: { kind: 'idle' } };
const listeners = new Set<() => void>();

function set(next: Versions): void {
  held = next;
  for (const listen of listeners) listen();
}

function subscribe(listen: () => void): () => void {
  listeners.add(listen);
  return () => {
    listeners.delete(listen);
  };
}
