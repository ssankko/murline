// Indexing one file: bytes in, the piece's index out.

import { buildScore } from '@/score/build';
import { loadSheet } from '@/score/load';
import { summarize, type PieceIndex } from '@/score/summarize';
import { ScoreError } from '@/score/types';
import { invoke } from '@tauri-apps/api/core';

/** Reads a score file and summarises it. Every failure arrives as a `ScoreError`. */
export async function indexFile(absolutePath: string): Promise<PieceIndex> {
  const fileName = absolutePath.split('/').pop() || absolutePath;
  const osmd = await loadSheet(await readFile(absolutePath), fileName);
  return summarize(buildScore(osmd.Sheet), fileName);
}

async function readFile(path: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await invoke<ArrayBuffer>('read_file', { path }));
  } catch (error) {
    const detail = String(error);
    const missing = /no such file|not found/i.test(detail);
    throw new ScoreError(missing ? 'File not found' : 'Could not read the file', detail);
  }
}
