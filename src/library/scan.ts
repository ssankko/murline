// The launch scan: the Rust side answers which files must be parsed, and the window parses them.
// Runs once at launch and again for one piece when it opens. No watcher.

import { reasonOf } from '@/library/notice';
import { commands, type FileEntry } from '@/bindings';
import { ScoreError } from '@/score/types';
import { baseNameOf, indexBytes, pathOf, readScoreFile } from './index-file';

/** The folder whose scan has finished. A folder that failed is not remembered, so it is retried. */
let scanned: string | null = null;

/**
 * Scans the whole library folder, once per folder value: the launch scan, and again only when the
 * library points somewhere else. Rejects when the folder itself is gone.
 */
export async function scanLibrary(folder: string): Promise<void> {
  if (scanned === folder) return;
  for (const file of await commands.indexPlan(folder, null)) await index(folder, file);
  scanned = folder;
}

/** Brings one piece up to date before it opens, in case the file changed under the app. */
export async function reindexIfChanged(folder: string, relPath: string): Promise<void> {
  for (const file of await commands.indexPlan(folder, relPath)) await index(folder, file);
}

async function index(folder: string, file: FileEntry): Promise<void> {
  try {
    const path = pathOf(folder, file.relPath);
    const summary = await indexBytes(await readScoreFile(path), baseNameOf(path));
    await commands.indexUpsert(file.relPath, summary, file.mtime, file.size);
  } catch (error) {
    const reason =
      error instanceof ScoreError ? error.message : `Could not read the file: ${reasonOf(error)}`;
    await commands.indexMarkError(file.relPath, reason, file.mtime, file.size);
  }
}

/** The `error` column of a piece, as `index` writes it: the fixed reason, then the raw message. */
export function splitError(error: string): { reason: string; detail: string } {
  const at = error.indexOf(': ');
  return at < 0
    ? { reason: error, detail: '' }
    : { reason: error.slice(0, at), detail: error.slice(at + 2) };
}
