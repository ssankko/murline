// Where the settings of one play come from: the piece's own column, else the global default, else
// the built-in default. A piece column of NULL is what "inherit" looks like in the database, so 0
// and false are values like any other and never fall through.

import { knobValues, PIECE_DEFAULT_KEYS, readSettings, type Settings } from '@/db/db';
import type { PieceRow } from '@/library/queries';
import {
  DEFAULT_PLAY_SETTINGS,
  type HandsSetting,
  type KeyboardPreset,
  type PlaySettings,
} from '@/play/settings';

/** The settings a piece may hold of its own. Everything else about a play is global. */
export type PieceSettings = Pick<
  PlaySettings,
  | 'tempoMode'
  | 'tempoValue'
  | 'metronome'
  | 'countInBars'
  | 'hands'
  | 'keyboardPreset'
  | 'keyboardLo'
  | 'keyboardHi'
>;

export const PIECE_SETTING_KEYS = [
  'tempoMode',
  'tempoValue',
  'metronome',
  'countInBars',
  'hands',
  'keyboardPreset',
  'keyboardLo',
  'keyboardHi',
] as const satisfies readonly (keyof PieceSettings)[];

/** True for every field the piece left NULL, which is what the library shows muted. */
export type Inherited = Record<keyof PieceSettings, boolean>;

/** The piece-setting columns of a `piece` row, the only part of it resolution reads. */
export type PieceSettingRow = Pick<
  PieceRow,
  | 'tempo_mode'
  | 'tempo_value'
  | 'metronome'
  | 'count_in_bars'
  | 'hands'
  | 'keyboard_preset'
  | 'keyboard_lo'
  | 'keyboard_hi'
>;

/** A row that holds no setting of its own, which is what "Use global defaults" leaves behind. */
export const INHERITS_EVERYTHING: PieceSettingRow = {
  tempo_mode: null,
  tempo_value: null,
  metronome: null,
  count_in_bars: null,
  hands: null,
  keyboard_preset: null,
  keyboard_lo: null,
  keyboard_hi: null,
};

/** The three levels, field by field, with the ones the piece did not answer for. */
export function resolvePlaySettings(
  piece: PieceSettingRow,
  globals: Partial<PieceSettings>,
): { settings: PieceSettings; inherited: Inherited } {
  const own: { [K in keyof PieceSettings]: PieceSettings[K] | null } = {
    tempoMode: piece.tempo_mode === 'percent' || piece.tempo_mode === 'bpm' ? piece.tempo_mode : null,
    tempoValue: piece.tempo_value,
    metronome: piece.metronome === null ? null : piece.metronome !== 0,
    countInBars: piece.count_in_bars,
    hands: handsOf(piece.hands),
    keyboardPreset: presetOf(piece.keyboard_preset),
    keyboardLo: piece.keyboard_lo,
    keyboardHi: piece.keyboard_hi,
  };
  const settings: Record<string, unknown> = {};
  const inherited: Record<string, boolean> = {};
  for (const key of PIECE_SETTING_KEYS) {
    settings[key] = own[key] ?? globals[key] ?? DEFAULT_PLAY_SETTINGS[key];
    inherited[key] = own[key] === null;
  }
  return { settings: settings as PieceSettings, inherited: inherited as Inherited };
}

/** The Playing defaults group: the middle level of the resolution. Tempo mode is never global. */
export function pieceDefaultsOf(settings: Settings): Partial<PieceSettings> {
  return knobValues(settings, PIECE_DEFAULT_KEYS);
}

/** The same, for a caller that holds no settings of its own yet. */
export async function readPieceDefaults(): Promise<Partial<PieceSettings>> {
  return pieceDefaultsOf(await readSettings());
}

/**
 * What a settings field types under: the number when the text is one inside the span, otherwise the
 * last value that was, with the error to show beside it.
 */
export function validNumber(
  text: string,
  min: number,
  max: number,
  last: number,
): { value: number; error: string | null } {
  const value = Number(text);
  if (text.trim() === '' || !Number.isFinite(value) || value < min || value > max) {
    return { value: last, error: `Enter a number from ${min} to ${max}` };
  }
  return { value, error: null };
}

function handsOf(text: string | null): HandsSetting | null {
  return text === 'both' || text === 'left' || text === 'right' ? text : null;
}

/** The preset column holds "piece", "custom" or the key count as text. */
function presetOf(text: string | null): KeyboardPreset | null {
  if (text === 'piece' || text === 'custom') return text;
  const keys = Number(text);
  return text !== null && [25, 49, 61, 76, 88].includes(keys) ? (keys as KeyboardPreset) : null;
}
