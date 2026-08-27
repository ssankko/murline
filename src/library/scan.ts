// The launch scan: what the library folder holds against what the database knows. Runs once at
// launch and again for one piece when it opens. No watcher.

import { ScoreError } from '@/score/types';
import { invoke } from '@tauri-apps/api/core';
import { baseNameOf, indexBytes, pathOf, readScoreFile } from './index-file';
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
  relPath: string;
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
    const row = rows.get(file.relPath);
    if (!row || row.mtime !== file.mtime || row.size !== file.size) {
      actions.push({ kind: 'index', file });
    } else if (!row.present) {
      actions.push({ kind: 'restore', path: row.path });
    }
  }
  const onDisk = new Set(files.map((f) => f.relPath));
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
      files.filter((f) => f.relPath === relPath),
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
    const path = pathOf(folder, file.relPath);
    const summary = await indexBytes(await readScoreFile(path), baseNameOf(path));
    await upsertIndex(file.relPath, summary, file.mtime, file.size);
  } catch (error) {
    const reason =
      error instanceof ScoreError ? error.message : `Could not read the file: ${String(error)}`;
    await markError(file.relPath, reason, file.mtime, file.size);
  }
}

/** The `error` column of a piece, as `index` writes it: the fixed reason, then the raw message. */
export function splitError(error: string): { reason: string; detail: string } {
  const at = error.indexOf(': ');
  return at < 0
    ? { reason: error, detail: '' }
    : { reason: error.slice(0, at), detail: error.slice(at + 2) };
}
