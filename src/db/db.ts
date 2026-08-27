import { DEFAULT_LANE_LOOK, DEFAULT_SPLIT } from '@/lane/lane';
import type { Theme } from '@/look/use-dark';
import {
  DEFAULT_PLAY_SETTINGS,
  type HandsSetting,
  type KeyboardPreset,
} from '@/play/settings';
import Database from '@tauri-apps/plugin-sql';

/** Global settings, one row each in `setting`, stored as JSON. NULL means never written. */
export type Settings = {
  library_folder: string;
  /** The folder holding `mxl/` from the unpacked PDMX tarball; NULL until the user picks one. */
  pdmx_folder: string;
  onboarding_done: boolean;
  /** Id of the one MIDI input port to listen on; NULL listens on every port. */
  midi_device: string | null;
  /** System follows `prefers-color-scheme`; Light and Dark pin the paper. */
  theme: Theme;
  /** Share of the window height the sheet takes, 0.2 to 0.6. */
  sheet_split: number;
  /** Beats of lane visible above the now-line. */
  lane_lookahead: number;
  /** Width of a falling block as a percent of its key. */
  lane_note_width: number;
  /** Gap between two blocks of the same key, in pixels. */
  lane_gap: number;
  keyboard_labels: boolean;
  /** Loudness of the metronome click, 0 to 100. */
  click_volume: number;

  // Defaults of the piece settings: what a piece plays at while it holds none of its own. Tempo
  // has no mode here, because BPM belongs to a piece written at one tempo.

  default_tempo_value: number;
  default_metronome: boolean;
  default_count_in_bars: number;
  default_hands: HandsSetting;
  default_keyboard_preset: KeyboardPreset;
  default_keyboard_lo: number;
  default_keyboard_hi: number;

  // Grade knobs. Global only, so two grades of one piece stay comparable.

  grade_timing_flat_ms: number;
  grade_timing_zero_ms: number;
  grade_velocity_flat: number;
  grade_velocity_zero: number;
  grade_release_flat_lo: number;
  grade_release_flat_hi: number;
  grade_release_zero_lo: number;
  grade_release_zero_hi: number;
  grade_weight_timing: number;
  grade_weight_velocity: number;
  grade_weight_release: number;
  /** Added to every strike's velocity before Grade reads it, to true up a keyboard. */
  velocity_offset: number;
  /** Half-width of the span around an Onset in which a strike counts for it, in milliseconds. */
  matching_window_ms: number;
  /** How far apart the first and last strike of one chord may be, in milliseconds. */
  togetherness_ms: number;
};

/** What every setting holds until the user writes it, and what "Reset group" writes back. */
export const SETTING_DEFAULTS: Settings = {
  library_folder: '',
  pdmx_folder: '',
  onboarding_done: false,
  midi_device: null,
  theme: 'system',
  sheet_split: DEFAULT_SPLIT,
  lane_lookahead: DEFAULT_LANE_LOOK.lookaheadBeats,
  lane_note_width: DEFAULT_LANE_LOOK.noteWidthPct,
  lane_gap: DEFAULT_LANE_LOOK.gapPx,
  keyboard_labels: DEFAULT_LANE_LOOK.keyLabels,
  click_volume: 70,
  default_tempo_value: DEFAULT_PLAY_SETTINGS.tempoValue,
  default_metronome: DEFAULT_PLAY_SETTINGS.metronome,
  default_count_in_bars: DEFAULT_PLAY_SETTINGS.countInBars,
  default_hands: DEFAULT_PLAY_SETTINGS.hands,
  default_keyboard_preset: DEFAULT_PLAY_SETTINGS.keyboardPreset,
  default_keyboard_lo: DEFAULT_PLAY_SETTINGS.keyboardLo,
  default_keyboard_hi: DEFAULT_PLAY_SETTINGS.keyboardHi,
  grade_timing_flat_ms: DEFAULT_PLAY_SETTINGS.timingFlatMs,
  grade_timing_zero_ms: DEFAULT_PLAY_SETTINGS.timingZeroMs,
  grade_velocity_flat: DEFAULT_PLAY_SETTINGS.velocityFlat,
  grade_velocity_zero: DEFAULT_PLAY_SETTINGS.velocityZero,
  grade_release_flat_lo: DEFAULT_PLAY_SETTINGS.releaseFlatLo,
  grade_release_flat_hi: DEFAULT_PLAY_SETTINGS.releaseFlatHi,
  grade_release_zero_lo: DEFAULT_PLAY_SETTINGS.releaseZeroLo,
  grade_release_zero_hi: DEFAULT_PLAY_SETTINGS.releaseZeroHi,
  grade_weight_timing: DEFAULT_PLAY_SETTINGS.weightTiming,
  grade_weight_velocity: DEFAULT_PLAY_SETTINGS.weightVelocity,
  grade_weight_release: DEFAULT_PLAY_SETTINGS.weightRelease,
  velocity_offset: DEFAULT_PLAY_SETTINGS.velocityOffset,
  matching_window_ms: DEFAULT_PLAY_SETTINGS.matchingWindowMs,
  togetherness_ms: DEFAULT_PLAY_SETTINGS.togethernessMs,
};

let opening: Promise<Database> | undefined;

/**
 * The one SQLite file, opened once and shared. Migrations run inside `load`. A failed open is
 * forgotten, so the next call opens again and a transient failure is one the user can retry.
 */
export function getDb(): Promise<Database> {
  opening ??= Database.load('sqlite:piano.db').catch((error: unknown) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

export async function getSetting<K extends keyof Settings>(key: K): Promise<Settings[K] | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>('SELECT value FROM setting WHERE key = $1', [
    key,
  ]);
  return rows.length ? (JSON.parse(rows[0]!.value) as Settings[K]) : null;
}

export async function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): Promise<void> {
  const db = await getDb();
  await db.execute(
    'INSERT INTO setting (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2',
    [key, JSON.stringify(value)],
  );
}

/** A global setting, with the default for one never written or a database that will not open. */
export async function getSettingOr<K extends keyof Settings>(
  key: K,
  fallback: Settings[K],
): Promise<Settings[K]> {
  try {
    return (await getSetting(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
