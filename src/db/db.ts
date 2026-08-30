import Database from '@tauri-apps/plugin-sql';

let opening: Promise<Database> | undefined;

/**
 * The one SQLite file, opened once and shared, holding the library's piece and play rows.
 * Migrations run inside `load`. A failed open is forgotten, so the next call opens again and a
 * transient failure is one the user can retry.
 */
export function getDb(): Promise<Database> {
  opening ??= Database.load('sqlite:murline.db').catch((error: unknown) => {
    opening = undefined;
    throw error;
  });
  return opening;
}
