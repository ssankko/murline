// What the library page keeps for itself about the `piece` rows: the columns the play toolbar
// writes, and the search the list pane runs over what came back. The rows themselves, and every
// command that reads or writes one, come from `src/bindings.ts`.

import type { PieceRow } from '@/bindings';

/** How the list pane is ordered. The choice is a global setting, never part of a piece. */
export type SortOrder = 'recent' | 'title' | 'composer' | 'grade' | 'favorites';

/**
 * Whether the list pane's search field keeps a row: its title or its composer holds the query as a
 * case-insensitive substring. An empty or blank query keeps every row.
 */
export function matches(row: Pick<PieceRow, 'title' | 'composer'>, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return [row.title, row.composer].some((field) => field?.toLowerCase().includes(needle));
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
