// The in-memory Rust side. Every test runs against it, and so does the app when the address
// carries `?mocktauri`. Its default answers are a working studio, so a test only writes the
// answers it is about.

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
 * The studio a test starts in: the sound engine is up on one output device with one file
 * instrument loaded, the effect chain is empty, one MIDI keyboard is listened to and the library
 * folder is empty.
 */
export const DEFAULT_ANSWERS: Answers = {
  ensure_dir: nothing,
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
  audio_set_keyboard_volume: nothing,
  audio_set_velocity_curve: nothing,
  audio_effects: () => [],
  audio_chain: () => [],
  // The engine answers with what it made of the chain, and it can load every plugin here.
  audio_set_chain: ({ chain }) => chain,
  audio_show_effect: nothing,
  audio_output_devices: () => [{ id: 'device-1', name: 'Built-in Output' }],
  audio_set_output_device: nothing,
  audio_set_buffer_frames: nothing,
  audio_set_sample_rate: nothing,
  audio_set_voices: nothing,
  audio_instruments: () => [
    { id: 'grand', name: 'Concert Grand Piano', kind: 'file', loaded: true, reason: '' },
  ],
  audio_load_instrument: nothing,
  audio_show_instrument: () => null,
  audio_envelope: () => ({ attack: 0.001, decay: 0.5, sustain: 0.7, release: 0.2 }),
  audio_set_envelope: nothing,
  audio_set_role_level: nothing,
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
