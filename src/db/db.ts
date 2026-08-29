import type { EffectSlot } from "@/audio/effects";
import type { Envelope } from "@/audio/envelope";
import type { Role } from "@/audio/roles";
import {
  DEFAULT_LANE_LOOK,
  DEFAULT_SPLIT,
  type LaneHarmony,
  type LaneLook,
} from "@/lane/lane";
import type { SortOrder } from "@/library/queries";
import type { Theme } from "@/look/use-dark";
import {
  DEFAULT_PLAY_SETTINGS,
  type InactiveHandVelocity,
  type KeyboardPreset,
  type PlaySettings,
} from "@/play/settings";
import type { SettingsTab } from "@/screens/settings";
import { DEFAULT_SPACING } from "@/sheet/sheet";
import Database from "@tauri-apps/plugin-sql";

/** Global settings, one row each in `setting`, stored as JSON. NULL means never written. */
export type Settings = {
  library_folder: string;
  /** The folder holding `mxl/` from the unpacked PDMX tarball; empty until the user picks one. */
  pdmx_folder: string;
  onboarding_done: boolean;
  /** How the library page orders its list. */
  library_sort: SortOrder;
  /** Folder-relative path of the piece the library page opens on; NULL takes the first row. */
  library_selected: string | null;
  /** The tab the settings panel opens on. */
  settings_tab: SettingsTab;
  /** How far that tab was scrolled when it was last left, in pixels. */
  settings_scroll: number;
  /** Id of the MIDI input port every launch starts on; NULL listens on every port not hidden. */
  midi_device: string | null;
  /** Ids of the MIDI input ports the player has put away, which "Any device" passes over. */
  midi_hidden: string[];
  /** System follows `prefers-color-scheme`; Light and Dark pin the paper. */
  theme: Theme;
  /** Share of the window height the sheet takes, 0.2 to 0.6. */
  sheet_split: number;
  /** Measures and notes take their width from their duration, so the cursor runs at one speed. */
  sheet_proportional: boolean;
  /**
   * Paper a bar spaced by time takes over the tightest bar's pixels per tick, a percent inside
   * `SPACING_MIN` to `SPACING_MAX`.
   */
  sheet_spacing: number;
  /** Beats of lane visible above the now-line. */
  lane_lookahead: number;
  /** Width of a falling block as a percent of its key. */
  lane_note_width: number;
  /** Gap between two blocks of the same key, in pixels. */
  lane_gap: number;
  keyboard_labels: boolean;

  // What the two views show of a note beyond its place in time: the harmony display and the pitch
  // colouring, each switchable on the sheet and in the falling notes on its own.

  sheet_harmony: boolean;
  sheet_colour: boolean;
  lane_harmony: LaneHarmony;
  lane_colour: boolean;
  /** Whether each falling block carries the name of its note. */
  lane_names: boolean;
  /** Whether the keyboard marks the keys outside the scale in force. */
  keyboard_scale_marks: boolean;

  /** Loudness of the metronome click, 0 to 100. */
  click_volume: number;
  /** The mixer's keyboard fader, 0 to 100: a gain after the effect chain in the sound engine, so
   * it trims everything the instrument path makes without changing how it makes it. */
  keyboard_volume: number;
  /** The effects the sound engine plays the instrument through, in the order they play. */
  effect_chain: EffectSlot[];

  // The velocity curve: the remap from the velocity the keyboard sends to the velocity the app
  // works in. All three reach the engine ahead of the instrument, and the same map is put on the
  // strike the webview is told about, so grading and Wait mode read the output velocity too.

  /** The output velocity the lightest strike lands on, 1 to 127. */
  velocity_min: number;
  /** The output velocity the hardest strike lands on, 1 to 127. Never below `velocity_min`. */
  velocity_max: number;
  /** The exponent of the path between the two. Above 1 makes soft playing softer, below 1 fills
   * out sooner, and exactly 1 is a straight line between the two ends. */
  velocity_curve: number;

  /** Opaque id of the device the sound engine plays through; NULL is the system default. */
  audio_output_device: string | null;
  /** Frames the output device runs per buffer: 32, 64, 128 or 256. Smaller is lower latency. */
  audio_buffer_frames: number;
  /** The rate the sound engine renders at, in Hz: 44100, 48000, 88200 or 96000. The device is
   * asked to run at it too. Every voice costs in proportion, so 96000 is twice the render load
   * of 48000. */
  audio_sample_rate: number;
  /** Voices the sound engine may hold sounding at once: 128, 256 or 512. Twice the count in
   * streaming ring slots is allocated with a sampled instrument, at 256 KB each, so 512 voices
   * cost 256 MB of buffers for an EXS. */
  audio_voices: number;

  // The sound engine's instrument. The id is opaque: only the engine knows whether it names a
  // file or an Audio Unit.

  /** The instrument the engine plays; NULL means none is chosen and the app is silent. */
  instrument_id: string | null;
  /** What a plugin instrument's own window was last left set to. */
  instrument_state: string | null;
  /** The envelope each sampler instrument has been given, under the instrument's own opaque id.
   * One missing from here plays with the envelope its file asks for, which is why this holds only
   * the instruments the user has actually shaped. Plugins never appear: they have their own
   * window for it. */
  instrument_envelopes: Record<string, Envelope>;
  /** The level of each role, 0 to 100, under the instrument's own opaque id. A role missing from an
   * instrument's map sounds at 100, which is why this holds only what the user has moved. */
  instrument_roles: Record<string, Partial<Record<Role, number>>>;
  /** Folder of `.sf2` and `.exs` files the picker lists; empty lists none of its own. */
  instruments_folder: string;

  // Keyboard size: how many keys the lane lays out, for every piece. "piece" fits each piece's own
  // range; a number is that many keys; "custom" uses the two bounds.

  keyboard_preset: KeyboardPreset;
  keyboard_lo: number;
  keyboard_hi: number;

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
  /** Half-width of the span around an Onset in which a strike counts for it, in milliseconds. */
  matching_window_ms: number;
  /** How far apart the first and last strike of one chord may be, in milliseconds. */
  togetherness_ms: number;
  /** Whether the hand the player is not playing sounds itself while a play runs. */
  play_inactive_hand: boolean;
  /** Which loudness that hand plays at: the written dynamics, or the player's own strikes. */
  play_inactive_hand_velocity: InactiveHandVelocity;
  /** Percent of that loudness it sounds at, inside `INACTIVE_HAND_LEVEL`. */
  play_inactive_hand_level: number;
};

/** The global knobs a running play reads, and the field of `PlaySettings` each one lands in. */
export const ENGINE_KNOBS = {
  grade_timing_flat_ms: "timingFlatMs",
  grade_timing_zero_ms: "timingZeroMs",
  grade_velocity_flat: "velocityFlat",
  grade_velocity_zero: "velocityZero",
  grade_release_flat_lo: "releaseFlatLo",
  grade_release_flat_hi: "releaseFlatHi",
  grade_release_zero_lo: "releaseZeroLo",
  grade_release_zero_hi: "releaseZeroHi",
  grade_weight_timing: "weightTiming",
  grade_weight_velocity: "weightVelocity",
  grade_weight_release: "weightRelease",
  matching_window_ms: "matchingWindowMs",
  togetherness_ms: "togethernessMs",
  play_inactive_hand: "inactiveHandSounds",
  play_inactive_hand_velocity: "inactiveHandVelocity",
  play_inactive_hand_level: "inactiveHandLevel",
  keyboard_preset: "keyboardPreset",
  keyboard_lo: "keyboardLo",
  keyboard_hi: "keyboardHi",
} as const satisfies Record<string, keyof PlaySettings>;

/** The same for the lane's look, which the next frame reads out of the live object. */
export const LANE_KNOBS = {
  lane_lookahead: "lookaheadBeats",
  lane_note_width: "noteWidthPct",
  lane_gap: "gapPx",
  keyboard_labels: "keyLabels",
  lane_harmony: "harmony",
  lane_colour: "colour",
  lane_names: "names",
  keyboard_scale_marks: "scaleMarks",
} as const satisfies Record<string, keyof LaneLook>;

/** One block of `SETTING_DEFAULTS`: each key takes the built-in default of the field it names. */
function knobDefaults<S, M extends Record<string, keyof S>>(
  from: S,
  knobs: M,
): { [K in keyof M]: S[M[K]] } {
  return Object.fromEntries(
    Object.entries(knobs).map(([key, field]) => [key, from[field]]),
  ) as { [K in keyof M]: S[M[K]] };
}

/** The fields a knob map names, read off a settings object: the reverse of `knobDefaults`. */
export function knobValues<M extends Partial<Record<keyof Settings, string>>>(
  settings: Settings,
  knobs: M,
): { [K in keyof M as M[K] & string]: Settings[K & keyof Settings] } {
  return Object.fromEntries(
    Object.entries(knobs).map(([key, field]) => [
      field,
      settings[key as keyof Settings],
    ]),
  ) as { [K in keyof M as M[K] & string]: Settings[K & keyof Settings] };
}

/** What every setting holds until the user writes it, and what "Reset group" writes back. */
export const SETTING_DEFAULTS: Settings = {
  library_folder: "",
  pdmx_folder: "",
  onboarding_done: false,
  library_sort: "title",
  library_selected: null,
  settings_tab: "sound",
  settings_scroll: 0,
  midi_device: null,
  midi_hidden: [],
  theme: "system",
  sheet_split: DEFAULT_SPLIT,
  sheet_proportional: false,
  sheet_spacing: DEFAULT_SPACING,
  sheet_harmony: true,
  sheet_colour: true,
  click_volume: 70,
  keyboard_volume: 100,
  effect_chain: [],
  velocity_min: 1,
  velocity_max: 127,
  velocity_curve: 1,
  audio_output_device: null,
  audio_buffer_frames: 64,
  audio_sample_rate: 44100,
  audio_voices: 128,
  instrument_id: null,
  instrument_state: null,
  instrument_envelopes: {},
  instrument_roles: {},
  instruments_folder: "",
  ...knobDefaults(DEFAULT_LANE_LOOK, LANE_KNOBS),
  ...knobDefaults(DEFAULT_PLAY_SETTINGS, ENGINE_KNOBS),
};

let opening: Promise<Database> | undefined;

/**
 * The one SQLite file, opened once and shared. Migrations run inside `load`. A failed open is
 * forgotten, so the next call opens again and a transient failure is one the user can retry.
 */
export function getDb(): Promise<Database> {
  opening ??= Database.load("sqlite:piano.db").catch((error: unknown) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

export async function getSetting<K extends keyof Settings>(
  key: K,
): Promise<Settings[K] | null> {
  const db = await getDb();
  const rows = await db.select<{ value: string }[]>(
    "SELECT value FROM setting WHERE key = $1",
    [key],
  );
  return rows.length ? (JSON.parse(rows[0]!.value) as Settings[K]) : null;
}

export async function setSetting<K extends keyof Settings>(
  key: K,
  value: Settings[K],
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO setting (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
    [key, JSON.stringify(value)],
  );
}

/** A global setting, with the default for one never written or a database that will not open. */
export async function getSettingOr<K extends keyof Settings>(
  key: K,
  fallback: Settings[K] = SETTING_DEFAULTS[key],
): Promise<Settings[K]> {
  try {
    return (await getSetting(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Every global setting in one read, each one never written held at its default. */
export async function readSettings(): Promise<Settings> {
  try {
    const db = await getDb();
    const rows = await db.select<{ key: string; value: string }[]>(
      "SELECT key, value FROM setting",
    );
    // A value of another type than its default is from an older shape of the setting, so the
    // default stands in for it; a null default accepts anything.
    const written = rows
      .map((row) => [row.key, JSON.parse(row.value) as unknown] as const)
      .filter(([key, value]) => {
        // A `KeyboardPreset` is a name or a count of keys, so both types are its own.
        if (key === "keyboard_preset")
          return typeof value === "string" || typeof value === "number";
        const fallback = SETTING_DEFAULTS[key as keyof Settings];
        return fallback == null || typeof value === typeof fallback;
      });
    return { ...SETTING_DEFAULTS, ...Object.fromEntries(written) } as Settings;
  } catch {
    return { ...SETTING_DEFAULTS };
  }
}
