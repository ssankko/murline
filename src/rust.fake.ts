// The in-memory Rust side. Every test runs against it, and so does the app when the address
// carries `?mocktauri`. Its default answers are a working studio, so a test only writes the
// answers it is about. It stands behind Tauri's own IPC mock, so the window calls `src/bindings.ts`
// exactly as it does against the real Rust side.

import {
  commands,
  events,
  type AudioStatus,
  type FileEntry,
  type PdmxStatus,
  type PieceRow,
  type PlayRow,
  type Refusal,
  type UpdateStatus,
} from '@/bindings';
import type { SortOrder } from '@/library/queries';
import { mockIPC } from '@tauri-apps/api/mocks';
import type { EventName, EventPayload } from '@/rust';

/** The camelCase name the bindings give a command, back as the snake_case name it is invoked
 * under, which is the name a test writes. */
type Snake<S extends string> = S extends `${infer Head}${infer Rest}`
  ? `${Head extends Lowercase<Head> ? Head : `_${Lowercase<Head>}`}${Snake<Rest>}`
  : S;

/** What one command answers with. A command the Rust side answers nothing with answers `null`,
 * which is what the window's `invoke` sees for it. */
type Answer<K extends keyof typeof commands> =
  Awaited<ReturnType<(typeof commands)[K]>> extends void
    ? null
    : Awaited<ReturnType<(typeof commands)[K]>>;

/**
 * What the window sent with a command: one key per Rust parameter, in camelCase. Only the Rust
 * signature knows their shapes, so an answer reads the ones it needs and is trusted about them.
 */
type Args = Record<string, any>;

/** One answer per command, as a function so an override can count calls or refuse. A command
 * without one here does not compile. */
export type Answers = {
  [K in keyof typeof commands as Snake<K & string>]: (
    args: Args,
  ) => Answer<K> | Promise<Answer<K>>;
};

/** Every command the Rust side registers, by the name the window invokes it under. */
export type CommandName = keyof Answers;

const nothing = () => null;

/** The PDMX job as a test finds it: nothing downloaded and nothing running. */
const idlePdmx = (): PdmxStatus => ({
  ready: false,
  running: false,
  done: 0,
  total: null,
  error: null,
});

/** The update job as a test finds it: the release page unasked and nothing waiting or fetched. */
export const idleUpdate = (): UpdateStatus => ({
  waiting: null,
  checked: false,
  installed: null,
  running: false,
  done: 0,
  total: null,
  error: null,
});

/** What an answer throws to refuse the way the Rust side does. */
export function refusal(kind: Refusal['kind'], text: string): Refusal {
  return { kind, text };
}

/** The engine as a test finds it: up on one output device, playing one file instrument. */
const running = (): AudioStatus => ({
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
});

/**
 * The `setting` table: what `settings_write` has stored and `settings_read` answers with. A test
 * seeds it before it loads the store, and `fakeRust` empties it, so every test starts on the
 * defaults.
 */
export const fakeSettings = new Map<string, unknown>();

/** One row of the `piece` table, with the file facts the scan compares against. */
type FakePiece = PieceRow & { mtime: number; size: number; present: number };

/**
 * The `piece` table and the `play` ledger the library commands work on. A test fills them through
 * the commands themselves, and `fakeRust` empties them, so every test starts on an empty library.
 */
const fakePieces = new Map<string, FakePiece>();
const fakePlays: (PlayRow & { piece_path: string })[] = [];

/**
 * The library folder on disk: what the walk finds. A test fills it before it scans, and `fakeRust`
 * empties it, so every test starts on an empty folder.
 */
export const fakeFiles: FileEntry[] = [];

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
    tempo_bpm: null,
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
    return null;
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
    return null;
  },
  piece_update_position: ({ path, tick }) => {
    Object.assign(fakePieces.get(path) ?? {}, { position_tick: tick });
    return null;
  },
  piece_set_favorite: ({ path, favorite }) => {
    Object.assign(fakePieces.get(path) ?? {}, { favorite: favorite ? 1 : 0 });
    return null;
  },
  piece_recent_plays: ({ path, limit }) =>
    fakePlays
      .filter((row) => row.piece_path === path)
      .sort((a, b) => b.started_at - a.started_at)
      .slice(0, limit),
  play_insert: ({ path, kind, startedAt, durationS }) => {
    play(path, {
      kind,
      started_at: Math.round(startedAt),
      duration_s: durationS,
      tempo_mode: null,
      tempo_value: null,
      hands: null,
      grade: null,
    });
    return null;
  },
  performance_insert: ({ path, run }) => {
    play(path, {
      kind: 'performance',
      started_at: Math.round(run.startedAt),
      duration_s: run.seconds,
      tempo_mode: run.tempoMode,
      tempo_value: run.tempoValue,
      hands: run.hands,
      grade: run.grade?.grade ?? null,
    });
    return null;
  },
  index_plan: ({ path }) => {
    const files = fakeFiles.filter((file) => path === null || file.relPath === path);
    const rows = [...fakePieces.values()].filter((row) => path === null || row.path === path);
    const onDisk = new Set(files.map((file) => file.relPath));
    for (const row of rows) if (row.present && !onDisk.has(row.path)) row.present = 0;
    return files.filter((file) => {
      const row = fakePieces.get(file.relPath);
      if (!row || row.mtime !== file.mtime || row.size !== file.size) return true;
      row.present = 1;
      return false;
    });
  },
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
      tempo_bpm: index.tempoBpm,
      key_sharps: index.keySharps,
      key_mode: index.keyMode,
      part_count: index.partCount,
      part_name: index.partName,
      mtime,
      size,
      present: 1,
      error: null,
    });
    return null;
  },
  index_mark_error: ({ path, error, mtime, size }) => {
    fakePieces.set(path, {
      ...(fakePieces.get(path) ?? blankPiece(path)),
      mtime,
      size,
      present: 1,
      error,
    });
    return null;
  },
  piece_delete: ({ path }) => {
    fakePieces.delete(path);
    // The foreign key cascades, so a piece takes its plays with it.
    const kept = fakePlays.filter((row) => row.piece_path !== path);
    fakePlays.length = 0;
    fakePlays.push(...kept);
    return null;
  },
  audio_start: nothing,
  audio_status: running,
  audio_click: nothing,
  audio_note: nothing,
  audio_effects: () => [],
  audio_chain: () => [],
  audio_show_effect: nothing,
  audio_output_devices: () => [{ id: 'device-1', name: 'Built-in Output' }],
  audio_instruments: () => [
    { id: 'grand', name: 'Concert Grand Piano', kind: 'file', loaded: true, reason: '' },
  ],
  // The engine puts the kept envelope and role levels on inside the load and answers its status.
  audio_load_instrument: running,
  audio_unload_instrument: (): AudioStatus => ({ ...running(), instrument: '', instrument_rate: 0 }),
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
  list_library: () => [...fakeFiles],
  read_file: () => new ArrayBuffer(0),
  remove_temp_file: nothing,
  reveal_in_finder: nothing,
  trash_file: nothing,
  finder_search: () => ({ rows: [], more: 0 }),
  finder_download: () => '/tmp/score.mxl',
  pdmx_status: idlePdmx,
  pdmx_fetch: idlePdmx,
  pdmx_cancel: nothing,
  app_version: () => '0.1.0',
  update_status: idleUpdate,
  // The newest build, until a test says another version waits.
  update_check: () => ({ ...idleUpdate(), checked: true }),
  // With nothing waiting there is nothing to install, which is the failure the Rust side reports.
  update_install: () => ({ ...idleUpdate(), checked: true, error: 'no newer version is waiting' }),
  update_restart: nothing,
};

/** One command the window asked for, in the order it asked. */
interface Called {
  name: CommandName;
  args: Record<string, unknown>;
}

/** One fake's own answers and the calls they have taken. */
interface Stand {
  answers: Answers;
  calls: Called[];
}

/** The fake answering the window now: whichever `fakeRust` or `install` put there last. */
let standing: Stand = { answers: DEFAULT_ANSWERS, calls: [] };
let mocked = false;

/** Puts the fake behind Tauri's own IPC, once. The listeners `listen` registers live in that mock,
 * so they outlast a fake, which is what a module that subscribes once needs. */
function mock(): void {
  if (mocked) return;
  mocked = true;
  mockIPC((name, args) => {
    // Tauri's own plugins knock at the same door. Nothing here runs them, and `null` is the answer
    // every one of them reads as nothing: no window, no chosen file, not fullscreen.
    if (name.startsWith('plugin:')) return null;
    const called: Called = {
      name: name as CommandName,
      args: (args ?? {}) as Record<string, unknown>,
    };
    standing.calls.push(called);
    const answer = standing.answers[called.name] as ((args: Args) => unknown) | undefined;
    if (!answer) throw new Error(`the fake was asked for ${name}, which is not a command`);
    return answer(called.args);
  }, { shouldMockEvents: true });
}

/** The handle a test holds on the fake it installed. */
export interface FakeRust {
  /** Every command call so far, oldest first. */
  calls: Called[];
  /** The arguments of every call of one command. */
  argsOf(name: CommandName): Args[];
  /** Every setting written so far, oldest first, in the shape the store sent it. */
  written(): [string, unknown][];
  /** Sends an event, as the Rust side would. Its listeners run before this returns. */
  emit<K extends EventName>(name: K, payload: EventPayload<K>): void;
  /** Puts this fake back behind the door, for a test file whose module under test subscribes to
   * events once and keeps the handlers it registered. */
  install(): void;
}

/**
 * Puts a fresh fake behind `src/bindings.ts` and hands back the handle on it. Calling it again
 * replaces the one before, so a `beforeEach` can start every test from the same studio.
 */
export function fakeRust(overrides: Partial<Answers> = {}): FakeRust {
  fakeSettings.clear();
  fakePieces.clear();
  fakePlays.length = 0;
  fakeFiles.length = 0;
  const stand: Stand = { answers: { ...DEFAULT_ANSWERS, ...overrides }, calls: [] };
  standing = stand;
  mock();

  return {
    calls: stand.calls,
    argsOf: (name) => stand.calls.filter((one) => one.name === name).map((one) => one.args),
    written: () =>
      stand.calls
        .filter((one) => one.name === 'settings_write')
        .map((one) => one.args as { key: string; value: unknown })
        .map(({ key, value }) => [key, value]),
    emit: (name, payload) => {
      void (events[name].emit as (payload: unknown) => Promise<void>)(payload);
    },
    install: () => {
      standing = stand;
    },
  };
}
