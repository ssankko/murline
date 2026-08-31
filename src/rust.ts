// The one door between the window and the Rust side. Every command and every event is named here
// once, with the shape it takes and the shape it answers, and this is the only module in `src/`
// that imports `invoke` and `listen`. Tests and the `?mocktauri` dev mode put `src/rust.fake.ts`
// behind `setRust`, so the door has a second adapter rather than a mocked import.

import type { PreviewNote } from '@/audio/preview';
import type {
  PieceRow,
  PieceSettingValues,
  PlayRow,
  SortOrder,
} from '@/library/queries';
import type { PerformanceRecord, StrikeEvent } from '@/play/engine';
import type { PieceIndex } from '@/score/summarize';
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/** One part of a sampled instrument beside the tone a key-down sounds. */
export type Role = 'release' | 'key_off' | 'sympathetic' | 'pedal_noise';

/** What the sound engine answers about itself: whether sound can come out, and why not when it
 * cannot. */
export interface AudioStatus {
  available: boolean;
  reason: string;
  /** Opaque id of the device playing now; null while the engine plays through none. */
  device: string | null;
  device_name: string;
  /** What is playing now; empty when nothing is loaded, which `reason` then explains. */
  instrument: string;
  /** Why the device playing is not the one chosen; empty while the choice is honoured. */
  fallback: string;
  buffer_frames: number;
  sample_rate: number;
  /** The buffer sizes the device playing takes, ascending; empty when there is no engine to ask. */
  buffer_choices: number[];
  /** The rate the loaded instrument's samples were recorded at; 0 for a plugin or nothing. */
  instrument_rate: number;
  /** What the device reports the buffer costs, in milliseconds. */
  latency_ms: number;
  /** The roles beyond the tone the loaded instrument offers; empty for a plugin or a plain file. */
  roles: Role[];
}

/** A status with nothing in it, which is what an engine that cannot even be asked answers. */
export const NO_STATUS: AudioStatus = {
  available: false,
  reason: '',
  device: null,
  device_name: '',
  instrument: '',
  fallback: '',
  buffer_frames: 0,
  sample_rate: 0,
  buffer_choices: [],
  instrument_rate: 0,
  latency_ms: 0,
  roles: [],
};

/** One device the engine can play through: an opaque id and the name to show. */
export interface OutputDevice {
  id: string;
  name: string;
}

/** One line of the instrument picker. The id is opaque; only the engine knows what it names. */
export interface Instrument {
  id: string;
  name: string;
  /** `file` for one the engine's sampler loads, `plugin` for a hosted Audio Unit. */
  kind: string;
  loaded: boolean;
  /** Why this instrument is silent, when it is the chosen one and its load failed. */
  reason: string;
}

/** One installed effect, as the Add menu lists it. */
export interface Effect {
  id: string;
  name: string;
  manufacturer: string;
}

/** One place in the effect chain. `missing` is the engine's word about this Mac, so it is never
 * stored. */
export interface EffectSlot {
  /** Opaque here: the engine's name for the plugin, the same on every Mac that has it. */
  id: string;
  /** What the plugin was called when it was last seen, which is how a missing slot is named. */
  name: string;
  bypass: boolean;
  /** The plugin's own settings, base64, read out when the user closes its window. */
  state: string;
  missing?: boolean;
}

/** Seconds, except `sustain`, which is the fraction of full loudness a held note settles at. */
export interface Envelope {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

/** One MIDI input port as the MIDI popover lists it. */
export interface MidiPort {
  id: string;
  name: string;
}

/** What the Rust side says about the MIDI keyboard: the ports it listens to, every port the
 * machine has, the one port pinned if there is one, and why there is no MIDI at all. */
export interface MidiPorts {
  devices: string[];
  ports: MidiPort[];
  pinned: string | null;
  error: string | null;
}

/** One score file of the library folder. `relPath` is the piece's identity; `mtime` and `size` say
 * whether it changed since it was indexed. */
export interface FileEntry {
  relPath: string;
  mtime: number;
  size: number;
}

/** What a copied file was when it landed: enough to tell later whether it changed. */
export interface Stamp {
  mtime: number;
  size: number;
}

/** One score finder hit, with everything its two lines show and the name the file lands under. */
export interface FinderRow {
  provider: 'KernScores' | 'PDMX';
  /** Composer heading, shared by both providers after normalisation. */
  heading: string;
  title: string;
  opus: string | null;
  number: string | null;
  movement: number | null;
  movementName: string | null;
  key: string | null;
  time: string | null;
  bars: number | null;
  ratings: number;
  /** The uploader's own title when it differs from the site's title field. */
  alt: string | null;
  file: string;
  fileName: string;
}

export interface SearchResult {
  rows: FinderRow[];
  /** Matches beyond the rows returned. */
  more: number;
}

/** Bytes of the PDMX archive read so far, and its size where the server declares one. */
export interface PdmxProgress {
  done: number;
  total: number | null;
}

/** What one pass of the render block cost: the voices sounding, the most the engine holds, and the
 * pass's own time as a percent of the buffer it filled. */
export interface Meter {
  voices: number;
  limit: number;
  load: number;
}

/** Where the Preview's transport stands, sent about thirty times a second. */
export interface PreviewProgress {
  seconds: number;
  playing: boolean;
}

/**
 * Every command the Rust side registers, with what it takes and what it answers. `args: void` is a
 * command called with nothing. The node test in `src/rust.test.ts` holds this list level with
 * `generate_handler!` in `src-tauri/src/lib.rs`.
 */
export interface Commands {
  ensure_dir: { args: { path: string }; result: void };
  /** Every stored global setting, by key, as the JSON the window wrote. */
  settings_read: { args: void; result: Record<string, unknown> };
  /** One setting. A key the sound engine owns is refused with the engine's reason. */
  settings_write: { args: { key: string; value: unknown }; result: void };
  /** Every piece whose file is in the folder, in the order the list pane asked for. */
  piece_list: { args: { sort: SortOrder }; result: PieceRow[] };
  piece_paths: { args: void; result: string[] };
  piece_get: { args: { path: string }; result: PieceRow | null };
  /** Only the nine piece-setting columns are written; a column set to null unsets it. */
  piece_update_settings: { args: { path: string; values: PieceSettingValues }; result: void };
  piece_update_position: { args: { path: string; tick: number }; result: void };
  piece_set_favorite: { args: { path: string; favorite: boolean }; result: void };
  piece_recent_plays: { args: { path: string; limit: number }; result: PlayRow[] };
  play_insert: {
    args: { path: string; kind: PlayRow['kind']; startedAt: number; durationS: number };
    result: void;
  };
  performance_insert: { args: { path: string; run: PerformanceRecord }; result: void };
  /**
   * The files whose bytes the window must parse: the library folder walked, or the one file at
   * `path` looked at, against the rows. Rows whose file came back or went away are flipped there.
   */
  index_plan: { args: { folder: string; path: string | null }; result: FileEntry[] };
  index_upsert: {
    args: { path: string; index: PieceIndex; mtime: number; size: number };
    result: void;
  };
  index_mark_error: {
    args: { path: string; error: string; mtime: number; size: number };
    result: void;
  };
  /** The piece goes, and its plays with it. */
  piece_delete: { args: { path: string }; result: void };
  audio_start: { args: void; result: void };
  audio_status: { args: void; result: AudioStatus };
  audio_click: { args: { strength: 'strong' | 'weak'; volume: number }; result: void };
  audio_note: { args: { midi: number; velocity: number; on: boolean; raw: boolean }; result: void };
  audio_effects: { args: void; result: Effect[] };
  audio_chain: { args: void; result: EffectSlot[] };
  audio_show_effect: { args: { index: number }; result: void };
  audio_output_devices: { args: void; result: OutputDevice[] };
  audio_instruments: { args: { folder: string }; result: Instrument[] };
  /** The engine reads the state, the envelope and the role levels kept for the id itself, and
   * answers with its status once the instrument is in. */
  audio_load_instrument: { args: { id: string }; result: AudioStatus };
  audio_show_instrument: { args: void; result: string | null };
  audio_envelope: { args: void; result: Envelope | null };
  audio_apply_envelope: { args: { envelope: Envelope }; result: void };
  audio_apply_role_level: { args: { role: Role; percent: number }; result: void };
  preview_load: { args: { notes: PreviewNote[] }; result: void };
  preview_play: { args: void; result: void };
  preview_pause: { args: void; result: void };
  preview_seek: { args: { seconds: number }; result: void };
  preview_rate: { args: { percent: number }; result: void };
  preview_stop: { args: void; result: void };
  midi_status: { args: void; result: MidiPorts };
  midi_listen: { args: { pinned: string | null; hidden: string[] }; result: void };
  copy_file: { args: { src: string; dst: string }; result: Stamp };
  list_library: { args: { folder: string }; result: FileEntry[] };
  read_file: { args: { path: string }; result: ArrayBuffer };
  remove_temp_file: { args: { path: string }; result: void };
  reveal_in_finder: { args: { path: string }; result: void };
  trash_file: { args: { path: string }; result: void };
  finder_search: { args: { query: string; pdmx: boolean }; result: SearchResult };
  finder_download: { args: { row: FinderRow }; result: string };
  /** Whether the PDMX tarball is unpacked; the Rust side owns the folder it is unpacked into. */
  pdmx_status: { args: void; result: boolean };
  pdmx_fetch: { args: { progress: (at: PdmxProgress) => void }; result: void };
  pdmx_cancel: { args: void; result: void };
  /** The version this build was made as. */
  app_version: { args: void; result: string };
  /** The version waiting on the release page, or null when this build is the newest. */
  update_check: { args: void; result: string | null };
  /** Fetches the newer bundle and swaps the app on disk; it starts at the next launch. */
  update_install: { args: void; result: void };
  /** Starts the app again. It never answers: this process is replaced by the new one. */
  update_restart: { args: void; result: void };
}

export type CommandName = keyof Commands;

/** Every event the Rust side emits, with the payload it carries. */
export interface Events {
  'midi-ports': MidiPorts;
  'midi-strike': StrikeEvent;
  'midi-pedal': { value: number };
  'audio-devices-changed': void;
  'audio-load': Meter;
  'audio-chain-changed': EffectSlot[];
  'preview-progress': PreviewProgress;
}

export type EventName = keyof Events;

/** What answers commands and events in place of the Tauri runtime. */
export interface Rust {
  call: (name: CommandName, args?: Record<string, unknown>) => Promise<unknown>;
  on: (name: EventName, handler: (payload: never) => void) => () => void;
}

let stand: Rust | null = null;

/** Puts a fake behind the door, or `null` to go back to the Tauri runtime. */
export function setRust(fake: Rust | null): void {
  stand = fake;
}

/** Asks the Rust side for one thing. */
export function call<K extends CommandName>(
  name: K,
  ...rest: Commands[K]['args'] extends void ? [] : [Commands[K]['args']]
): Promise<Commands[K]['result']> {
  const args = rest[0] as Record<string, unknown> | undefined;
  const answer = stand ? stand.call(name, args) : invoke(name, args && channelled(args));
  return answer as Promise<Commands[K]['result']>;
}

/** A function argument is a stream of reports as a command runs, which the Tauri runtime carries
 * on a channel of its own. */
function channelled(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => {
      if (typeof value !== 'function') return [key, value];
      const channel = new Channel<unknown>();
      channel.onmessage = value as (message: unknown) => void;
      return [key, channel];
    }),
  );
}

/** Listens to one event until the returned function is called. */
export function on<K extends EventName>(
  name: K,
  handler: (payload: Events[K]) => void,
): () => void {
  if (stand) return stand.on(name, handler as (payload: never) => void);
  let stop: (() => void) | undefined;
  let stopped = false;
  void listen(name, (event) => handler(event.payload as Events[K]))
    .then((unlisten) => {
      if (stopped) unlisten();
      else stop = unlisten;
    })
    .catch(() => {});
  return () => {
    stopped = true;
    stop?.();
  };
}
