// Where the settings of one play come from: the piece's own column, else the built-in default.
// There is no level between the two. A piece column of NULL is a setting the piece has never been
// given, so 0 and false are values like any other and never fall through.

import { PIECE_SETTING_COLUMNS, type PieceSettingRow } from '@/library/queries';
import {
  DEFAULT_PLAY_SETTINGS,
  type HandsSetting,
  type PlayMode,
  type PlaySettings,
} from '@/play/settings';

/** The settings a piece holds of its own. Everything else about a play is global. */
export type PieceSettings = Pick<PlaySettings, keyof typeof PIECE_SETTING_COLUMNS>;

/** A row holding no setting of its own, which is what a piece never opened before looks like. */
export const UNSET_PIECE_SETTINGS = Object.fromEntries(
  Object.values(PIECE_SETTING_COLUMNS).map((column) => [column, null]),
) as PieceSettingRow;

/** The piece's own value in every field it has one, and the built-in default in the rest. */
export function resolvePlaySettings(piece: PieceSettingRow): PieceSettings {
  const own: { [K in keyof PieceSettings]: PieceSettings[K] | null } = {
    tempoMode: piece.tempo_mode === 'percent' || piece.tempo_mode === 'bpm' ? piece.tempo_mode : null,
    tempoValue: piece.tempo_value,
    metronome: piece.metronome === null ? null : piece.metronome !== 0,
    countInBars: piece.count_in_bars,
    hands: handsOf(piece.hands),
    mode: modeOf(piece.mode),
    loop: piece.loop === null ? null : piece.loop !== 0,
    // A Section is two indices or neither, and null is the built-in default, so both fall through
    // together. The bars they name may be gone from the file; the play screen is where that shows.
    sectionFrom: piece.section_from,
    sectionTo: piece.section_to,
  };
  const settings: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(own) as [keyof PieceSettings, unknown][]) {
    settings[key] = value ?? DEFAULT_PLAY_SETTINGS[key];
  }
  return settings as PieceSettings;
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

function modeOf(text: string | null): PlayMode | null {
  return text === 'flow' || text === 'wait' ? text : null;
}
