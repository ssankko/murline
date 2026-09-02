// Indexing one file: bytes in, the piece's index out.

import { buildScore } from '@/score/build';
import { loadSheet } from '@/score/load';
import { commands, type FileEntry } from '@/bindings';
import { isRefusal } from '@/rust';
import { reasonOf } from '@/library/notice';
import { summarize, type PieceIndex } from '@/score/summarize';
import { ScoreError } from '@/score/types';

/** Summarises the bytes of a score file. The file name only fills in a missing title or composer. */
export async function indexBytes(bytes: Uint8Array, fileName: string): Promise<PieceIndex> {
  const osmd = await loadSheet(bytes, fileName);
  return summarize(buildScore(osmd.Sheet), fileName);
}

export function baseNameOf(path: string): string {
  return path.split('/').pop() || path;
}

/** A file of the library folder by its folder-relative path. The folder may end in a slash. */
export function pathOf(folder: string, relPath: string): string {
  return `${folder.replace(/\/+$/, '')}/${relPath}`;
}

/** Every score file under the library folder, at any depth, in no particular order. */
export function listLibrary(folder: string): Promise<FileEntry[]> {
  return commands.listLibrary(folder);
}

export async function readScoreFile(path: string): Promise<Uint8Array> {
  try {
    // The bytes come back as the raw body of the answer, which nothing on the Rust side types.
    return new Uint8Array((await commands.readFile(path)) as ArrayBuffer);
  } catch (error) {
    const reason = isMissingFile(error) ? 'File not found' : 'Could not read the file';
    throw new ScoreError(reason, reasonOf(error));
  }
}

/** Whether a refusal from Rust is the file being gone rather than anything else. */
export function isMissingFile(error: unknown): boolean {
  return isRefusal(error) && error.kind === 'gone';
}
