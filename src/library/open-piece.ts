// The one way a screen opens a piece of the library: the index is brought up to date in case the
// file changed, the bytes are read, and the piece's own row and settings come back with them. The
// play screen and the Preview both start here.

import { baseNameOf, pathOf, readScoreFile } from '@/library/index-file';
import { getPiece, type PieceRow } from '@/library/queries';
import { reindexIfChanged } from '@/library/scan';
import { resolvePlaySettings, UNSET_PIECE_SETTINGS, type PieceSettings } from '@/play/resolve';

/** One piece as a screen opens it: what to render, and what to render it under. */
export interface OpenedPiece {
  bytes: Uint8Array;
  /** The file's own name, which names the piece until the score says what it is called. */
  fileName: string;
  /** The piece's row, or null for a piece the library has never written one for. */
  row: PieceRow | null;
  /** The row's settings over the built-in defaults. */
  resolved: PieceSettings;
}

export async function openPiece(folder: string, path: string): Promise<OpenedPiece> {
  await reindexIfChanged(folder, path);
  const bytes = await readScoreFile(pathOf(folder, path));
  const row = await getPiece(path).catch(() => null);
  return {
    bytes,
    fileName: baseNameOf(path),
    row,
    resolved: resolvePlaySettings(row ?? UNSET_PIECE_SETTINGS),
  };
}
