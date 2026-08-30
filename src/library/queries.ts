// Every `piece` and `play` command the library page runs, and the shapes they answer with. The
// Rust side holds the rows; nothing here is more than the call and the search the list pane runs
// over what came back.

import type { PerformanceRecord } from '@/play/engine';
import { call } from '@/rust';
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
  /** Piece settings. NULL in any of them means the piece has never been given that one. */
  tempo_mode: string | null;
  tempo_value: number | null;
  metronome: number | null;
  count_in_bars: number | null;
  hands: string | null;
  mode: string | null;
  loop: number | null;
  section_from: number | null;
  section_to: number | null;
  /** Played tick the practice was left at, which is where the piece reopens. NULL is its start. */
  position_tick: number | null;
  best_grade: number | null;
  last_played: number | null;
  practised_s: number | null;
}

/** One play of a piece, as the History ledger reads it. A practice leaves the last columns NULL. */
export interface PlayRow {
  id: number;
  kind: 'practice' | 'performance';
  started_at: number;
  duration_s: number;
  tempo_mode: string | null;
  tempo_value: number | null;
  hands: string | null;
  grade: number | null;
}

/** What the file was when it was last indexed, and whether it is still there. */
export interface KnownFile {
  path: string;
  mtime: number;
  size: number;
  present: number;
}

/** How the list pane is ordered. The choice is a global setting, never part of a piece. */
export type SortOrder = 'recent' | 'title' | 'composer' | 'grade' | 'favorites';

/** Every piece whose file is in the folder. A missing file hides its piece until it is back. */
export async function listPieces(sort: SortOrder = 'title'): Promise<PieceRow[]> {
  return call('piece_list', { sort });
}

/**
 * Whether the list pane's search field keeps a row: its title or its composer holds the query as a
 * case-insensitive substring. An empty or blank query keeps every row.
 */
export function matches(row: Pick<PieceRow, 'title' | 'composer'>, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [row.title, row.composer].some((field) => field?.toLowerCase().includes(needle));
}

/**
 * The path of every piece whose file is in the folder, whatever the list pane is filtered to. The
 * finder reads it to know which of its rows are already downloaded.
 */
export async function allPiecePaths(): Promise<string[]> {
  return call('piece_paths');
}

/** Every piece setting: the field of a play it sets, and the `piece` column it lives in. */
export const PIECE_SETTING_COLUMNS = {
  tempoMode: 'tempo_mode',
  tempoValue: 'tempo_value',
  metronome: 'metronome',
  countInBars: 'count_in_bars',
  hands: 'hands',
  mode: 'mode',
  loop: 'loop',
  sectionFrom: 'section_from',
  sectionTo: 'section_to',
} as const satisfies Record<string, keyof PieceRow>;

/** The piece-setting columns of a `piece` row, the only part of it resolution reads. */
export type PieceSettingRow = Pick<
  PieceRow,
  (typeof PIECE_SETTING_COLUMNS)[keyof typeof PIECE_SETTING_COLUMNS]
>;

/** The piece settings as their columns; a column set to null unsets that setting again. */
export type PieceSettingValues = Partial<PieceSettingRow>;

/** Stores what the play screen just changed. */
export async function updatePieceSettings(
  path: string,
  values: PieceSettingValues,
): Promise<void> {
  return call('piece_update_settings', { path, values });
}

/**
 * Stores where the play screen left the cursor, in played ticks. It is state of the piece rather
 * than a setting: no control shows it and no play reads it out of its settings.
 */
export async function updatePiecePosition(path: string, tick: number): Promise<void> {
  return call('piece_update_position', { path, tick });
}

/** The one thing the library writes about a piece. */
export async function setFavorite(path: string, favorite: boolean): Promise<void> {
  return call('piece_set_favorite', { path, favorite });
}

export async function getPiece(path: string): Promise<PieceRow | null> {
  return call('piece_get', { path });
}

/** The last plays of a piece, newest first: the History ledger of the detail pane. */
export async function recentPlays(path: string, limit = 6): Promise<PlayRow[]> {
  return call('piece_recent_plays', { path, limit });
}

/** Stores one finished play. Nothing on screen announces it. */
export async function insertPlay(
  path: string,
  kind: PlayRow['kind'],
  startedAt: number,
  durationS: number,
): Promise<void> {
  return call('play_insert', { path, kind, startedAt, durationS });
}

/**
 * Stores one complete performance: what it ran at, then what it earned. A run with nothing to grade
 * leaves the grade columns empty.
 */
export async function insertPerformance(path: string, run: PerformanceRecord): Promise<void> {
  return call('performance_insert', { path, run });
}

export async function knownFiles(): Promise<KnownFile[]> {
  return call('index_known_files');
}

/** Writes a fresh index. The row's favorite, settings and history survive, and any error clears. */
export async function upsertIndex(
  path: string,
  index: PieceIndex,
  mtime: number,
  size: number,
): Promise<void> {
  return call('index_upsert', { path, index, mtime, size });
}

/** A file the app cannot read stays a piece: it gains the reason and keeps its old index columns. */
export async function markError(
  path: string,
  error: string,
  mtime: number,
  size: number,
): Promise<void> {
  return call('index_mark_error', { path, error, mtime, size });
}

/** Whether the file is in the folder. A row absent from it keeps its history and leaves the list. */
export async function setPresent(path: string, present: boolean): Promise<void> {
  return call('index_set_present', { path, present });
}

/** Drops the piece, and its plays with it through the foreign key that cascades. */
export async function deletePiece(path: string): Promise<void> {
  return call('piece_delete', { path });
}
