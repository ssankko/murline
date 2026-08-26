// Every `piece` query the library page runs. History numbers are read from `play` on the spot;
// nothing derived is stored.

import { getDb } from '@/db/db';
import type { PieceIndex } from '@/score/summarize';

/** A piece as the library page reads it: its index columns, its file facts and its history. */
export interface PieceRow {
  path: string;
  title: string | null;
  composer: string | null;
  measure_count: number | null;
  duration_s: number | null;
  midi_lo: number | null;
  midi_hi: number | null;
  has_tempo: number | null;
  constant_tempo: number | null;
  key_sharps: number | null;
  key_mode: string | null;
  part_count: number | null;
  part_name: string | null;
  favorite: number;
  error: string | null;
  best_grade: number | null;
  last_played: number | null;
  practised_s: number | null;
}

/** What the file was when it was last indexed, and whether it is still there. */
export interface KnownFile {
  path: string;
  mtime: number;
  size: number;
  present: number;
}

const HISTORY = `
  (SELECT MAX(grade) FROM play WHERE piece_path = piece.path AND kind = 'performance') AS best_grade,
  (SELECT MAX(started_at) FROM play WHERE piece_path = piece.path) AS last_played,
  (SELECT SUM(duration_s) FROM play WHERE piece_path = piece.path) AS practised_s`;

/** How the list pane is ordered. The choice lives in the page, never in the database. */
export type SortOrder = 'recent' | 'title' | 'composer' | 'grade' | 'favorites';

const BY_TITLE = 'title COLLATE NOCASE';

// SQLite sorts NULL below every value, so a descending sort puts the never-played and the
// ungraded last on its own.
const SORTS: Record<SortOrder, { where: string; order: string }> = {
  recent: { where: '', order: `last_played DESC, ${BY_TITLE}` },
  title: { where: '', order: BY_TITLE },
  composer: { where: '', order: `composer COLLATE NOCASE, ${BY_TITLE}` },
  grade: { where: '', order: `best_grade DESC, ${BY_TITLE}` },
  favorites: { where: 'AND favorite = 1', order: BY_TITLE },
};

/** Every piece whose file is in the folder. A missing file hides its piece until it is back. */
export async function listPieces(sort: SortOrder = 'title'): Promise<PieceRow[]> {
  const db = await getDb();
  const { where, order } = SORTS[sort];
  return db.select<PieceRow[]>(
    `SELECT path, title, composer, measure_count, duration_s, midi_lo, midi_hi, has_tempo,
            constant_tempo, key_sharps, key_mode, part_count, part_name, favorite, error,
            ${HISTORY}
     FROM piece WHERE present = 1 ${where} ORDER BY ${order}`,
  );
}

/** The one thing the library writes about a piece. */
export async function setFavorite(path: string, favorite: boolean): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE piece SET favorite = $2 WHERE path = $1', [path, favorite ? 1 : 0]);
}

export async function getPiece(path: string): Promise<PieceRow | null> {
  const db = await getDb();
  const rows = await db.select<PieceRow[]>(
    `SELECT path, title, composer, measure_count, duration_s, midi_lo, midi_hi, has_tempo,
            constant_tempo, key_sharps, key_mode, part_count, part_name, favorite, error,
            ${HISTORY}
     FROM piece WHERE path = $1`,
    [path],
  );
  return rows[0] ?? null;
}

export async function knownFiles(): Promise<KnownFile[]> {
  const db = await getDb();
  return db.select<KnownFile[]>('SELECT path, mtime, size, present FROM piece');
}

/** Writes a fresh index. The row's favorite, settings and history survive, and any error clears. */
export async function upsertIndex(
  path: string,
  index: PieceIndex,
  mtime: number,
  size: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO piece (path, title, composer, measure_count, duration_s, midi_lo, midi_hi,
                        has_tempo, constant_tempo, key_sharps, key_mode, part_count, part_name,
                        mtime, size, present, imported_at, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, $16, NULL)
     ON CONFLICT(path) DO UPDATE SET
       title = $2, composer = $3, measure_count = $4, duration_s = $5, midi_lo = $6, midi_hi = $7,
       has_tempo = $8, constant_tempo = $9, key_sharps = $10, key_mode = $11, part_count = $12,
       part_name = $13, mtime = $14, size = $15, present = 1, error = NULL`,
    [
      path,
      index.title,
      index.composer,
      index.measureCount,
      index.durationS,
      index.midiLo,
      index.midiHi,
      index.hasTempo ? 1 : 0,
      index.constantTempo ? 1 : 0,
      index.keySharps,
      index.keyMode,
      index.partCount,
      index.partName,
      mtime,
      size,
      Date.now(),
    ],
  );
}

/** A file the app cannot read stays a piece, with the reason in place of its facts. */
export async function markError(
  path: string,
  error: string,
  mtime: number,
  size: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO piece (path, mtime, size, present, imported_at, error)
     VALUES ($1, $2, $3, 1, $4, $5)
     ON CONFLICT(path) DO UPDATE SET mtime = $2, size = $3, present = 1, error = $5`,
    [path, mtime, size, Date.now(), error],
  );
}

/** The file is gone: keep the row and its history, drop it from the list. */
export async function markMissing(path: string): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE piece SET present = 0 WHERE path = $1', [path]);
}

/** The same file is back, unchanged since it was indexed. */
export async function markPresent(path: string): Promise<void> {
  const db = await getDb();
  await db.execute('UPDATE piece SET present = 1 WHERE path = $1', [path]);
}

/** Drops the piece and its plays. The file itself goes to the Trash first, through `trash_file`. */
export async function deletePiece(path: string): Promise<void> {
  const db = await getDb();
  await db.execute('DELETE FROM play WHERE piece_path = $1', [path]);
  await db.execute('DELETE FROM piece WHERE path = $1', [path]);
}
