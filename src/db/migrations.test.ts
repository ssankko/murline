// The migrations are SQL files the Rust side hands to the SQL plugin, so they run against no
// TypeScript at all. These tests apply the real files to a real SQLite in order, seeding the shape
// the user's database is in today, because a migration is only proved on a database with data.

import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PIECE_SETTING_COLUMNS } from '@/library/queries';

const dir = fileURLToPath(new URL('../../src-tauri/migrations', import.meta.url));
const files = readdirSync(dir).sort();

/**
 * A database with every migration applied, `seed` running once migration `version` is in and the
 * ones after it are not, which is the shape the migration under test meets on a real machine.
 */
function migrate(version: number, seed?: (db: DatabaseSync) => void): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const [at, file] of files.entries()) {
    if (at === version) seed?.(db);
    db.exec(readFileSync(`${dir}/${file}`, 'utf8'));
  }
  return db;
}

function setting(db: DatabaseSync, key: string): unknown {
  const row = db.prepare('SELECT value FROM setting WHERE key = $key').get({ $key: key }) as
    | { value: string }
    | undefined;
  return row === undefined ? undefined : JSON.parse(row.value);
}

function write(db: DatabaseSync, key: string, value: unknown): void {
  db.prepare('INSERT INTO setting (key, value) VALUES ($key, $value)').run({
    $key: key,
    $value: JSON.stringify(value),
  });
}

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (each) => each.name,
  );
}

/** Before 0002: a piece holding settings of its own, under global defaults it fell back to. */
function inheritingDatabase(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO piece (path, mtime, size, imported_at, favorite, tempo_mode, tempo_value,
                        metronome, count_in_bars, hands, keyboard_preset, keyboard_lo, keyboard_hi)
     VALUES ('Bach.musicxml', 1, 2, 3, 1, 'bpm', 96, 1, 2, 'left', '61', NULL, NULL)`,
  ).run();
  write(db, 'default_tempo_value', 80);
  write(db, 'default_metronome', true);
  write(db, 'default_count_in_bars', 2);
  write(db, 'default_hands', 'left');
  write(db, 'library_folder', '/Users/me/Scores');
}

/** Before 0003: a piece practised under the settings it keeps, with nowhere to hold the rest. */
function practisedDatabase(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO piece (path, mtime, size, imported_at, favorite, tempo_mode, tempo_value,
                        metronome, count_in_bars, hands)
     VALUES ('Bach.musicxml', 1, 2, 3, 1, 'bpm', 96, 1, 2, 'left')`,
  ).run();
  write(db, 'library_folder', '/Users/me/Scores');
}

describe('0002, no inheritance', () => {
  it('carries a chosen keyboard preset into the global keyboard size row', () => {
    const db = migrate(1, (old) => {
      inheritingDatabase(old);
      write(old, 'default_keyboard_preset', 88);
    });
    expect(setting(db, 'keyboard_preset')).toBe(88);
    expect(setting(db, 'default_keyboard_preset')).toBeUndefined();
  });

  it('carries a custom range with its bounds', () => {
    const db = migrate(1, (old) => {
      inheritingDatabase(old);
      write(old, 'default_keyboard_preset', 'custom');
      write(old, 'default_keyboard_lo', 36);
      write(old, 'default_keyboard_hi', 71);
    });
    expect(setting(db, 'keyboard_preset')).toBe('custom');
    expect(setting(db, 'keyboard_lo')).toBe(36);
    expect(setting(db, 'keyboard_hi')).toBe(71);
  });

  it('leaves no keyboard size behind for a user who never chose one', () => {
    const db = migrate(1, inheritingDatabase);
    expect(setting(db, 'keyboard_preset')).toBeUndefined();
    expect(setting(db, 'keyboard_lo')).toBeUndefined();
  });

  it('drops the playing defaults and keeps every other setting', () => {
    const db = migrate(1, (old) => {
      inheritingDatabase(old);
      write(old, 'default_keyboard_preset', 88);
    });
    const keys = (db.prepare('SELECT key FROM setting').all() as { key: string }[]).map(
      (row) => row.key,
    );
    expect(keys.filter((key) => key.startsWith('default_'))).toEqual([]);
    expect(setting(db, 'library_folder')).toBe('/Users/me/Scores');
  });

  it('drops the three keyboard columns and keeps the piece and its other settings', () => {
    const db = migrate(1, inheritingDatabase);
    expect(columns(db, 'piece')).not.toContain('keyboard_preset');
    expect(columns(db, 'piece')).not.toContain('keyboard_lo');
    expect(columns(db, 'piece')).not.toContain('keyboard_hi');
    expect(db.prepare('SELECT * FROM piece').get()).toMatchObject({
      path: 'Bach.musicxml',
      favorite: 1,
      tempo_mode: 'bpm',
      tempo_value: 96,
      metronome: 1,
      count_in_bars: 2,
      hands: 'left',
    });
  });

  it('runs on a database that was never opened before', () => {
    const db = migrate(1);
    expect(db.prepare('SELECT * FROM piece').all()).toEqual([]);
    expect(columns(db, 'piece')).not.toContain('keyboard_preset');
  });
});

describe('0003, the practice state persists', () => {
  it('gives the piece somewhere to hold its mode, Section and Loop', () => {
    const db = migrate(2, practisedDatabase);
    expect(columns(db, 'piece')).toEqual(
      expect.arrayContaining(['mode', 'loop', 'section_from', 'section_to']),
    );
  });

  it('leaves a piece practised before it with no practice state and every setting it had', () => {
    const db = migrate(2, practisedDatabase);
    // NULL in all four is what opens a piece in flow, with no Section and Loop off.
    expect(db.prepare('SELECT * FROM piece').get()).toMatchObject({
      path: 'Bach.musicxml',
      favorite: 1,
      tempo_mode: 'bpm',
      tempo_value: 96,
      metronome: 1,
      count_in_bars: 2,
      hands: 'left',
      mode: null,
      loop: null,
      section_from: null,
      section_to: null,
    });
    expect(setting(db, 'library_folder')).toBe('/Users/me/Scores');
  });

  it('takes a database still in the shape before 0002 all the way', () => {
    const db = migrate(1, inheritingDatabase);
    expect(columns(db, 'piece')).toEqual(expect.arrayContaining(['mode', 'section_from']));
    expect(db.prepare('SELECT * FROM piece').get()).toMatchObject({ hands: 'left', mode: null });
  });

  it('runs on a database that was never opened before', () => {
    const db = migrate(2);
    expect(db.prepare('SELECT * FROM piece').all()).toEqual([]);
    expect(columns(db, 'piece')).toContain('section_to');
  });
});

it('gives every piece setting a column to be written to', () => {
  // A setting named in the map but never added to the SQL takes every UPDATE down with it, and the
  // screen would look right until the piece was reopened.
  const piece = columns(migrate(0), 'piece');
  expect(piece).toEqual(expect.arrayContaining(Object.values(PIECE_SETTING_COLUMNS)));
});

it('applies every migration file the Rust side knows about', () => {
  // A file written but never registered runs on no database at all, and nothing else would say so.
  const lib = readFileSync(fileURLToPath(new URL('../../src-tauri/src/lib.rs', import.meta.url)), 'utf8');
  for (const file of files) expect(lib).toContain(file);
});
