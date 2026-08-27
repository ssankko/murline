// The launch scan: what the library folder holds against what the database knows. Runs once at
// launch and again for one piece when it opens. No watcher.

import { ScoreError } from '@/score/types';
import { invoke } from '@tauri-apps/api/core';
import { indexFile } from './index-file';
import {
  knownFiles,
  markError,
  markMissing,
  markPresent,
  upsertIndex,
  type KnownFile,
} from './queries';

/** One score file of the library folder, as Rust reports it. */
export interface FileEntry {
  rel_path: string;
  mtime: number;
  size: number;
}

export type ScanAction =
  | { kind: 'index'; file: FileEntry }
  | { kind: 'restore'; path: string }
  | { kind: 'hide'; path: string };

/**
 * What the scan has to do: index a file the database has never seen or whose mtime or size moved,
 * restore a row whose file came back untouched, hide a row whose file is gone. A row that matches
 * its file needs nothing.
 */
export function planScan(files: FileEntry[], known: KnownFile[]): ScanAction[] {
  const rows = new Map(known.map((row) => [row.path, row]));
  const actions: ScanAction[] = [];
  for (const file of files) {
    const row = rows.get(file.rel_path);
    if (!row || row.mtime !== file.mtime || row.size !== file.size) {
      actions.push({ kind: 'index', file });
    } else if (!row.present) {
      actions.push({ kind: 'restore', path: row.path });
    }
  }
  const onDisk = new Set(files.map((f) => f.rel_path));
  for (const row of known) {
    if (row.present && !onDisk.has(row.path)) actions.push({ kind: 'hide', path: row.path });
  }
  return actions;
}

/** The folder whose scan has finished. A folder that failed is not remembered, so it is retried. */
let scanned: string | null = null;

/**
 * Walks the whole library folder, once per folder value: the launch scan, and again only when the
 * library points somewhere else. Rejects when the folder itself is gone.
 */
export async function scanLibrary(folder: string): Promise<void> {
  if (scanned === folder) return;
  const files = await invoke<FileEntry[]>('list_library', { folder });
  await apply(folder, planScan(files, await knownFiles()));
  scanned = folder;
}

/** Brings one piece up to date before it opens, in case the file changed under the app. */
export async function reindexIfChanged(folder: string, relPath: string): Promise<void> {
  const files = await invoke<FileEntry[]>('list_library', { folder });
  const known = await knownFiles();
  await apply(
    folder,
    planScan(
      files.filter((f) => f.rel_path === relPath),
      known.filter((row) => row.path === relPath),
    ),
  );
}

async function apply(folder: string, actions: ScanAction[]): Promise<void> {
  for (const action of actions) {
    if (action.kind === 'restore') await markPresent(action.path);
    else if (action.kind === 'hide') await markMissing(action.path);
    else await index(folder, action.file);
  }
}

async function index(folder: string, file: FileEntry): Promise<void> {
  try {
    const summary = await indexFile(`${folder}/${file.rel_path}`);
    await upsertIndex(file.rel_path, summary, file.mtime, file.size);
  } catch (error) {
    const reason =
      error instanceof ScoreError
        ? `${error.reason}: ${error.detail}`
        : `Could not read the file: ${String(error)}`;
    await markError(file.rel_path, reason, file.mtime, file.size);
  }
}
