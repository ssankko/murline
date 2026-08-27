// Import: a file from anywhere on disk becomes a piece of the library folder. Every check runs
// before the copy, so a file the app cannot read never lands in the folder.

import { ScoreError } from '@/score/types';
import { invoke } from '@tauri-apps/api/core';
import { baseNameOf, indexBytes, readScoreFile } from './index-file';
import { upsertIndex } from './queries';
import type { FileEntry } from './scan';

/** The extensions the app reads, as the file picker and the drop handler both filter on. */
export const SCORE_EXTENSIONS = ['musicxml', 'xml', 'mxl'];

/** What the user answers when the folder already holds a file of that name. */
export type ClashChoice = 'replace' | 'keep-both' | 'cancel';

export interface ImportFailure {
  fileName: string;
  reason: string;
}

export interface ImportResult {
  /** Folder-relative paths of the pieces written, in import order. */
  imported: string[];
  failures: ImportFailure[];
}

export function isScoreFile(path: string): boolean {
  return SCORE_EXTENSIONS.includes(path.split('.').pop()?.toLowerCase() ?? '');
}

/**
 * Imports every path into the library folder and indexes it. A file that fails is reported, never
 * copied, and never stops the files after it. A clash the user cancels is silent.
 */
export async function importFiles(
  folder: string,
  paths: string[],
  onClash: (fileName: string) => Promise<ClashChoice>,
): Promise<ImportResult> {
  const imported: string[] = [];
  const failures: ImportFailure[] = [];
  for (const path of paths) {
    try {
      const relPath = await importOne(folder, path, onClash);
      if (relPath) imported.push(relPath);
    } catch (error) {
      failures.push({
        fileName: baseNameOf(path),
        reason: error instanceof ScoreError ? error.reason : 'Could not read the file',
      });
    }
  }
  return { imported, failures };
}

/** The folder-relative path of the new piece, or null when the user cancelled at the clash. */
async function importOne(
  folder: string,
  path: string,
  onClash: (fileName: string) => Promise<ClashChoice>,
): Promise<string | null> {
  const fileName = baseNameOf(path);
  if (!isScoreFile(fileName)) {
    throw new ScoreError('Not a MusicXML file', `${fileName} is not a score file`);
  }
  const bytes = await readScoreFile(path);
  if (bytes.length === 0) throw new ScoreError('Not a MusicXML file', `${fileName} is empty`);
  const index = await indexBytes(bytes, fileName);

  // APFS is case-insensitive, so a name that differs only in case is the same file to the folder.
  const taken = new Set(
    (await invoke<FileEntry[]>('list_library', { folder })).map((file) =>
      file.rel_path.toLowerCase(),
    ),
  );
  const isTaken = (name: string) => taken.has(name.toLowerCase());
  let relPath = fileName;
  if (isTaken(fileName)) {
    const choice = await onClash(fileName);
    if (choice === 'cancel') return null;
    if (choice === 'keep-both') relPath = freeName(fileName, isTaken);
  }

  const stamp = await invoke<{ mtime: number; size: number }>('copy_file', {
    src: path,
    dst: `${folder}/${relPath}`,
  });
  await upsertIndex(relPath, index, stamp.mtime, stamp.size);
  return relPath;
}

/** `name.ext` becomes `name (2).ext`, then `name (3).ext`, until the folder has no such file. */
function freeName(fileName: string, isTaken: (name: string) => boolean): string {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : '';
  for (let copy = 2; ; copy++) {
    const candidate = `${stem} (${copy})${extension}`;
    if (!isTaken(candidate)) return candidate;
  }
}
