import Database from '@tauri-apps/plugin-sql';

/** Global settings, one row each in `setting`, stored as JSON. NULL means never written. */
export type Settings = {
  library_folder: string;
  /** The folder holding `mxl/` from the unpacked PDMX tarball; NULL until the user picks one. */
  pdmx_folder: string;
  onboarding_done: boolean;
  /** Id of the one MIDI input port to listen on; NULL listens on every port. */
  midi_device: string;
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
};

let opening: Promise<Database> | undefined;

/** The one SQLite file, opened once and shared. Migrations run inside `load`. */
export function getDb(): Promise<Database> {
  opening ??= Database.load('sqlite:piano.db');
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
