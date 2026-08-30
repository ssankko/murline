// The in-memory Rust side. Every test runs against it, and so does the app when the address
// carries `?mocktauri`. Its default answers are a working studio, so a test only writes the
// answers it is about.

import type { KnownFile, PieceRow, PlayRow, SortOrder } from '@/library/queries';
import {
  setRust,
  type CommandName,
  type Commands,
  type EventName,
  type Events,
  type Rust,
} from '@/rust';

/** One answer per command, as a function so an override can count calls or refuse. */
export type Answers = {
  [K in CommandName]: (
    args: Commands[K]['args'],
  ) => Commands[K]['result'] | Promise<Commands[K]['result']>;
};

const nothing = () => {};

/**
 * The `setting` table: what `settings_write` has stored and `settings_read` answers with. A test
 * seeds it before it loads the store, and `fakeRust` empties it, so every test starts on the
 * defaults.
 */
export const fakeSettings = new Map<string, unknown>();

/** One row of the `piece` table, with the file facts the scan compares against. */
type FakePiece = PieceRow & Omit<KnownFile, 'path'>;

/**
 * The `piece` table and the `play` ledger the library commands work on. A test fills them through
 * the commands themselves, and `fakeRust` empties them, so every test starts on an empty library.
 */
export const fakePieces = new Map<string, FakePiece>();
export const fakePlays: (PlayRow & { piece_path: string })[] = [];

/** A piece with nothing about it known yet, which is what indexing a new file starts from. */
function blankPiece(path: string): FakePiece {
  return {
    path,
    title: null,
    composer: null,
    measure_count: null,
    duration_s: null,
    midi_lo: null,
    midi_hi: null,
    has_tempo: null,
    constant_tempo: null,
    key_sharps: null,
    key_mode: null,
    part_count: null,
    part_name: null,
    favorite: 0,
    error: null,
    tempo_mode: null,
    tempo_value: null,
    metronome: null,
    count_in_bars: null,
    hands: null,
    mode: null,
    loop: null,
    section_from: null,
    section_to: null,
    position_tick: null,
    best_grade: null,
    last_played: null,
    practised_s: null,
    mtime: 0,
    size: 0,
    present: 1,
  };
}

/** The history columns, read off the plays as the Rust side reads them off the `play` table. */
function withHistory(row: FakePiece) {
  const plays = fakePlays.filter((play) => play.piece_path === row.path);
  const graded = plays.filter((play) => play.kind === 'performance' && play.grade !== null);
  return {
    ...row,
    best_grade: graded.length === 0 ? null : Math.max(...graded.map((play) => play.grade ?? 0)),
    last_played: plays.length === 0 ? null : Math.max(...plays.map((play) => play.started_at)),
    practised_s:
      plays.length === 0 ? null : plays.reduce((total, play) => total + play.duration_s, 0),
  };
}

/** The list pane's orders. A row with no value sorts last, and title breaks every tie. */
function ordered(rows: PieceRow[], sort: SortOrder): PieceRow[] {
  const text = (value: string | null) => (value ?? '').toLowerCase();
  const down = (value: number | null) => value ?? -Infinity;
  const first: Record<SortOrder, (a: PieceRow, b: PieceRow) => number> = {
    recent: (a, b) => down(b.last_played) - down(a.last_played),
    grade: (a, b) => down(b.best_grade) - down(a.best_grade),
    composer: (a, b) => text(a.composer).localeCompare(text(b.composer)),
    title: () => 0,
    favorites: () => 0,
  };
  return [...rows].sort((a, b) => first[sort](a, b) || text(a.title).localeCompare(text(b.title)));
}

/** One new play of a piece, under the next free id. */
function play(piece_path: string, row: Omit<PlayRow, 'id'>): void {
  fakePlays.push({ id: fakePlays.length + 1, piece_path, ...row });
}

/**
 * The studio a test starts in: the sound engine is up on one output device with one file
 * instrument loaded, the effect chain is empty, one MIDI keyboard is listened to and the library
 * folder is empty.
 */
export const DEFAULT_ANSWERS: Answers = {
  ensure_dir: nothing,
  settings_read: () => Object.fromEntries(fakeSettings),
  settings_write: ({ key, value }) => {
    fakeSettings.set(key, value);
  },
  piece_list: ({ sort }) =>
    ordered(
      [...fakePieces.values()]
        .filter((row) => row.present === 1 && (sort !== 'favorites' || row.favorite === 1))
        .map(withHistory),
      sort,
    ),
  piece_paths: () =>
    [...fakePieces.values()].filter((row) => row.present === 1).map((row) => row.path),
  piece_get: ({ path }) => {
    const row = fakePieces.get(path);
    return row === undefined ? null : withHistory(row);
  },
  piece_update_settings: ({ path, values }) => {
    Object.assign(fakePieces.get(path) ?? {}, values);
  },
  piece_update_position: ({ path, tick }) => {
    Object.assign(fakePieces.get(path) ?? {}, { position_tick: tick });
  },
  piece_set_favorite: ({ path, favorite }) => {
    Object.assign(fakePieces.get(path) ?? {}, { favorite: favorite ? 1 : 0 });
  },
  piece_recent_plays: ({ path, limit }) =>
    fakePlays
      .filter((row) => row.piece_path === path)
      .sort((a, b) => b.started_at - a.started_at)
      .slice(0, limit),
  play_insert: ({ path, kind, startedAt, durationS }) =>
    play(path, {
      kind,
      started_at: Math.round(startedAt),
      duration_s: durationS,
      tempo_mode: null,
      tempo_value: null,
      hands: null,
      grade: null,
    }),
  performance_insert: ({ path, run }) =>
    play(path, {
      kind: 'performance',
      started_at: Math.round(run.startedAt),
      duration_s: run.seconds,
      tempo_mode: run.tempoMode,
      tempo_value: run.tempoValue,
      hands: run.hands,
      grade: run.grade?.grade ?? null,
    }),
  index_known_files: () =>
    [...fakePieces.values()].map(({ path, mtime, size, present }) => ({
      path,
      mtime,
      size,
      present,
    })),
  index_upsert: ({ path, index, mtime, size }) => {
    fakePieces.set(path, {
      ...(fakePieces.get(path) ?? blankPiece(path)),
      title: index.title,
      composer: index.composer,
      measure_count: index.measureCount,
      duration_s: index.durationS,
      midi_lo: index.midiLo,
      midi_hi: index.midiHi,
      has_tempo: index.hasTempo ? 1 : 0,
      constant_tempo: index.constantTempo ? 1 : 0,
      key_sharps: index.keySharps,
      key_mode: index.keyMode,
      part_count: index.partCount,
      part_name: index.partName,
      mtime,
      size,
      present: 1,
      error: null,
    });
  },
  index_mark_error: ({ path, error, mtime, size }) => {
    fakePieces.set(path, {
      ...(fakePieces.get(path) ?? blankPiece(path)),
      mtime,
      size,
      present: 1,
      error,
    });
  },
  index_set_present: ({ path, present }) => {
    Object.assign(fakePieces.get(path) ?? {}, { present: present ? 1 : 0 });
  },
  piece_delete: ({ path }) => {
    fakePieces.delete(path);
    // The foreign key cascades, so a piece takes its plays with it.
    const kept = fakePlays.filter((row) => row.piece_path !== path);
    fakePlays.length = 0;
    fakePlays.push(...kept);
  },
  audio_start: nothing,
  audio_status: () => ({
    available: true,
    reason: '',
    device: 'device-1',
    device_name: 'Built-in Output',
    instrument: 'Concert Grand Piano',
    fallback: '',
    buffer_frames: 128,
    sample_rate: 48000,
    buffer_choices: [32, 64, 128, 256, 512],
    instrument_rate: 44100,
    latency_ms: 5,
    roles: ['release', 'key_off', 'sympathetic', 'pedal_noise'],
  }),
  audio_click: nothing,
  audio_note: nothing,
  audio_effects: () => [],
  audio_chain: () => [],
  audio_show_effect: nothing,
  audio_output_devices: () => [{ id: 'device-1', name: 'Built-in Output' }],
  audio_instruments: () => [
    { id: 'grand', name: 'Concert Grand Piano', kind: 'file', loaded: true, reason: '' },
  ],
  audio_load_instrument: nothing,
  audio_show_instrument: () => null,
  audio_envelope: () => ({ attack: 0.001, decay: 0.5, sustain: 0.7, release: 0.2 }),
  audio_apply_envelope: nothing,
  audio_apply_role_level: nothing,
  preview_load: nothing,
  preview_play: nothing,
  preview_pause: nothing,
  preview_seek: nothing,
  preview_rate: nothing,
  preview_stop: nothing,
  midi_status: () => ({
    devices: ['Keyboard'],
    ports: [{ id: 'port-1', name: 'Keyboard' }],
    pinned: null,
    error: null,
  }),
  midi_listen: nothing,
  copy_file: () => ({ mtime: 1, size: 1 }),
  list_library: () => [],
  read_file: () => new ArrayBuffer(0),
  remove_temp_file: nothing,
  reveal_in_finder: nothing,
  trash_file: nothing,
  finder_search: () => ({ rows: [], more: 0 }),
  finder_download: () => '/tmp/score.mxl',
  pdmx_status: () => false,
  pdmx_fetch: () => '/pdmx',
  pdmx_cancel: nothing,
};

/** One command the window asked for, in the order it asked. */
export interface Called {
  name: CommandName;
  args: unknown;
}

/** The handle a test holds on the fake it installed. */
export interface FakeRust {
  /** Every command call so far, oldest first. */
  calls: Called[];
  /** The arguments of every call of one command. */
  argsOf<K extends CommandName>(name: K): Commands[K]['args'][];
  /** Sends an event, as the Rust side would. */
  emit<K extends EventName>(name: K, payload: Events[K]): void;
  /** Puts this fake back behind the door, for a test file whose module under test subscribes to
   * events once and keeps the handlers it registered. */
  install(): void;
}

/**
 * Puts a fresh fake behind `src/rust.ts` and hands back the handle on it. Calling it again
 * replaces the one before, so a `beforeEach` can start every test from the same studio.
 */
export function fakeRust(overrides: Partial<Answers> = {}): FakeRust {
  fakeSettings.clear();
  fakePieces.clear();
  fakePlays.length = 0;
  const answers = { ...DEFAULT_ANSWERS, ...overrides } as Answers;
  const calls: Called[] = [];
  const handlers = new Map<EventName, Set<(payload: unknown) => void>>();

  const rust: Rust = {
    call: async (name, args) => {
      calls.push({ name, args });
      return (answers[name] as (args: unknown) => unknown)(args);
    },
    on: (name, handler) => {
      const set = handlers.get(name) ?? new Set();
      handlers.set(name, set);
      set.add(handler as (payload: unknown) => void);
      return () => set.delete(handler as (payload: unknown) => void);
    },
  };
  setRust(rust);

  return {
    calls,
    argsOf: (name) => calls.filter((c) => c.name === name).map((c) => c.args) as never,
    emit: (name, payload) => {
      for (const handler of handlers.get(name) ?? []) handler(payload);
    },
    install: () => setRust(rust),
  };
}
