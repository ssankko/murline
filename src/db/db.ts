import Database from '@tauri-apps/plugin-sql';

/** Global settings, one row each in `setting`, stored as JSON. NULL means never written. */
export type Settings = {
  library_folder: string;
  /** The folder holding `mxl/` from the unpacked PDMX tarball; NULL until the user picks one. */
  pdmx_folder: string;
  onboarding_done: boolean;
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
