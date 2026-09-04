// What version runs and what the release page holds. Fetching the bundle is a job the Rust side
// owns, so it keeps going while the status bar is built again on every screen; where it stands is
// read from Rust on mount and kept current by the job's two events.

import { commands, type UpdateStatus } from '@/bindings';
import { makeStore } from '@/lib/store';
import { reasonOf } from '@/library/notice';
import { progressLabel } from '@/library/pdmx';
import { on } from '@/rust';
import { useEffect, useSyncExternalStore } from 'react';

/** Where the update stands. `ready` is a version on disk, waiting for the next launch. */
type Update =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'found'; version: string }
  | { kind: 'taking'; version: string; done: number; total: number | null }
  | { kind: 'ready'; version: string }
  | { kind: 'failed'; why: string };

/** The version running, empty until the Rust side has said, and what waits beyond it. */
export interface Versions {
  current: string;
  update: Update;
}

/** The Rust job as one of the states the cell draws. A running fetch outranks the reason the one
 * before it stopped, and a bundle on disk outranks the version it came from. */
export function updateOf(status: UpdateStatus): Update {
  const version = status.waiting ?? '';
  if (status.running) return { kind: 'taking', version, done: status.done, total: status.total };
  if (status.error) return { kind: 'failed', why: status.error };
  if (status.installed) return { kind: 'ready', version: status.installed };
  return status.waiting ? { kind: 'found', version } : { kind: 'idle' };
}

/** What the version cell reads: the version running, unless the update has more to say. */
export function versionText({ current, update }: Versions): string {
  switch (update.kind) {
    case 'checking':
      return 'Checking';
    case 'taking':
      return progressLabel(update);
    case 'ready':
      return 'Restart';
    case 'failed':
      return update.why;
    default:
      return current;
  }
}

/** What the tooltip over the version cell says. */
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
 * Asks the release page what it holds. A fetch already running is left alone, and so is a version
 * already on disk, which the check reports again as ready.
 */
export async function checkUpdate(): Promise<void> {
  const before = held.get().update;
  if (before.kind === 'checking' || before.kind === 'taking') return;
  held.set({ ...held.get(), update: { kind: 'checking' } });
  try {
    const current = held.get().current || (await commands.appVersion());
    held.set({ current, update: updateOf(await commands.updateCheck()) });
  } catch (error) {
    refuse(error);
  }
}

/** Starts fetching the version the check found. Only a click calls this. */
export async function takeUpdate(): Promise<void> {
  if (held.get().update.kind !== 'found') return;
  try {
    held.set({ ...held.get(), update: updateOf(await commands.updateInstall()) });
  } catch (error) {
    refuse(error);
  }
}

/** Starts the app again, which is how a version already on disk takes over. Nothing comes back:
 * this window goes down with the process it belongs to. */
export function restartApp(): void {
  commands.updateRestart().catch(() => {});
}

/** The version running and the update as it stands, as one value. */
export function versions(): Versions {
  return held.get();
}

/**
 * The same, for as long as the component asking is up, following the fetch job through its events.
 * The release page is asked once a launch, so building the bar again on another screen costs no
 * request; the cell's own click asks it again.
 */
export function useVersions(): Versions {
  useEffect(() => {
    // A progress message carries only the two numbers, so the version being fetched is kept.
    const stop = [
      on('updateProgress', ({ done, total }) =>
        held.set({ ...held.get(), update: { kind: 'taking', version: fetching(), done, total } }),
      ),
      on('updateDone', (status) => held.set({ ...held.get(), update: updateOf(status) })),
    ];
    void begin();
    return () => {
      for (const one of stop) one();
    };
  }, []);
  return useSyncExternalStore(held.subscribe, held.get);
}

const held = makeStore<Versions>({ current: '', update: { kind: 'idle' } });

/** Reads where the update stands and asks the release page the first time this launch. */
async function begin(): Promise<void> {
  try {
    const current = held.get().current || (await commands.appVersion());
    const status = await commands.updateStatus();
    // A check already in flight has more to say than the status it started from.
    if (held.get().update.kind === 'checking') return;
    held.set({ current, update: updateOf(status) });
    if (!status.checked) await checkUpdate();
  } catch (error) {
    refuse(error);
  }
}

/** The version the running fetch is of, which the states before and after it also name. */
function fetching(): string {
  const { update } = held.get();
  return 'version' in update ? update.version : '';
}

function refuse(error: unknown): void {
  held.set({ ...held.get(), update: { kind: 'failed', why: reasonOf(error) } });
}
