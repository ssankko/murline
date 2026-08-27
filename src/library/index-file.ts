// Indexing one file: bytes in, the piece's index out.

import { buildScore } from '@/score/build';
import { loadSheet } from '@/score/load';
import { summarize, type PieceIndex } from '@/score/summarize';
import { ScoreError } from '@/score/types';
import { invoke } from '@tauri-apps/api/core';

/** Reads a score file and summarises it. Every failure arrives as a `ScoreError`. */
export async function indexFile(absolutePath: string): Promise<PieceIndex> {
  const fileName = baseNameOf(absolutePath);
  return indexBytes(await readScoreFile(absolutePath), fileName);
}

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

export async function readScoreFile(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await invoke<ArrayBuffer>('read_file', { path }));
  } catch (error) {
    const detail = String(error);
    const missing = /no such file|not found/i.test(detail);
    throw new ScoreError(missing ? 'File not found' : 'Could not read the file', detail);
  }
}
