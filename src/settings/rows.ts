// One descriptor per row of the settings panel, the mixer and the MIDI popover: what the search
// box finds it by, the label it draws, whether its slider steps finely, and what the instrument
// must offer for it to be on the page. The row and the panel both read it, so a row is declared
// once.

import { makeStore } from "@/lib/store";
import type { Settings } from "@/settings/settings";
import { useSyncExternalStore } from "react";

export type SettingsTab = "sound" | "look" | "playing" | "library";

/** Where a row lives. The mixer and the MIDI devices are not tabs: they are the popovers behind
 * the bar's volume and MIDI buttons, and a result naming one of their controls opens that popover
 * instead of switching tab. */
export type SearchWhere = SettingsTab | "mixer" | "midi";

/** What the instrument playing offers: an envelope to shape, and roles beyond its tone. A hosted
 * plugin has neither, and the rows for them are off the page while it plays. */
export type Offered = { envelope: boolean; roles: boolean };

type RowShape = {
  id: string;
  tab: SearchWhere;
  label: string;
  /** The heading the row sits under, which tells apart the Look tab's two Harmony rows and its two
   * Pitch colours rows, alike in every other way. */
  group?: string;
  /** What a player types instead of the label, seeded from the _Avoid_ lines of `CONTEXT.md`. */
  words: readonly string[];
  /** Left and Right move the slider one step whether Shift is down or not: every step is worth
   * hearing. */
  fine?: true;
  /** Whether the row is on the page for what the instrument offers. A row without one always is. */
  shows?: (has: Offered) => boolean;
};

const envelope = (has: Offered): boolean => has.envelope;
const roles = (has: Offered): boolean => has.roles;

/**
 * The eleven knobs that shape a Grade, each with the span and the step its slider takes.
 * Uncalibrated, so they ship only in a dev build.
 */
export const GRADE_KNOBS = [
  ["grade_weight_timing", "Timing weight", 0, 1, 0.01],
  ["grade_weight_velocity", "Velocity weight", 0, 1, 0.01],
  ["grade_weight_release", "Release weight", 0, 1, 0.01],
  ["grade_timing_flat_ms", "Timing full marks (ms)", 0, 500, 1],
  ["grade_timing_zero_ms", "Timing zero (ms)", 1, 2000, 1],
  ["grade_velocity_flat", "Velocity full marks", 0, 127, 1],
  ["grade_velocity_zero", "Velocity zero", 1, 127, 1],
  ["grade_release_flat_lo", "Release full marks from", 0, 10, 0.01],
  ["grade_release_flat_hi", "Release full marks to", 0, 10, 0.01],
  ["grade_release_zero_lo", "Release zero below", 0, 10, 0.01],
  ["grade_release_zero_hi", "Release zero above", 0, 10, 0.01],
] as const satisfies readonly [
  key: keyof Settings,
  label: string,
  min: number,
  max: number,
  step: number,
][];

/**
 * Every row, declared here rather than read off the page, so a row on a tab that is not open is
 * still findable. A row belongs here only once the panel renders it: an entry for a row that is
 * not on screen sends the search to a tab with nothing on it, which is worse than finding nothing
 * at all.
 */
export const SETTING_ROWS = [
  {
    id: "keyboard_volume",
    tab: "mixer",
    label: "Keyboard",
    words: ["volume", "loudness", "gain", "level", "quiet", "night", "master"],
  },
  {
    id: "click_volume",
    tab: "mixer",
    label: "Metronome",
    words: ["volume", "loudness", "click", "beat", "level"],
  },
  {
    id: "audio_output_device",
    tab: "sound",
    label: "Output device",
    group: "Output",
    words: [
      "speakers",
      "headphones",
      "interface",
      "sound card",
      "playback engine",
    ],
  },
  {
    id: "audio_buffer_frames",
    tab: "sound",
    label: "Buffer (frames)",
    group: "Output",
    words: ["latency", "delay", "lag", "block size", "samples"],
  },
  {
    id: "audio_sample_rate",
    tab: "sound",
    label: "Sample rate (Hz)",
    group: "Instrument",
    words: [
      "khz",
      "44.1",
      "48",
      "96",
      "resample",
      "quality",
      "render load",
      "cpu",
    ],
  },
  {
    id: "audio_voices",
    tab: "sound",
    label: "Voices",
    group: "Output",
    words: ["polyphony", "notes at once", "voice limit", "memory", "streaming"],
  },
  {
    id: "instrument_id",
    tab: "sound",
    label: "Instrument",
    group: "Instrument",
    words: ["patch", "preset", "voice", "sound font", "synth", "piano sound"],
  },
  {
    id: "instruments_folder",
    tab: "sound",
    label: "Instruments folder",
    group: "Instrument",
    words: ["sf2", "exs", "sound fonts", "samples"],
  },
  {
    id: "role_release",
    tab: "sound",
    shows: roles,
    label: "Release samples",
    group: "Roles",
    words: ["damper", "key up", "noise", "level"],
  },
  {
    id: "role_key_off",
    tab: "sound",
    shows: roles,
    label: "Key-off noise",
    group: "Roles",
    words: ["key up", "mechanism", "noise", "level"],
  },
  {
    id: "role_sympathetic",
    tab: "sound",
    shows: roles,
    label: "Sympathetic resonance",
    group: "Roles",
    words: ["strings", "ringing", "pedal", "noise", "level"],
  },
  {
    id: "role_pedal_noise",
    tab: "sound",
    shows: roles,
    label: "Pedal noise",
    group: "Roles",
    words: ["sustain pedal", "thump", "noise", "level"],
  },
  {
    id: "velocity_min",
    tab: "sound",
    fine: true,
    label: "Minimum velocity",
    group: "Touch",
    words: ["quiet", "floor", "softest", "soft", "dynamics", "touch"],
  },
  {
    id: "velocity_max",
    tab: "sound",
    fine: true,
    label: "Maximum velocity",
    group: "Touch",
    words: ["loud", "ceiling", "hardest", "top", "dynamics", "touch"],
  },
  {
    id: "velocity_curve",
    tab: "sound",
    fine: true,
    label: "Velocity curve",
    group: "Touch",
    words: [
      "touch",
      "response",
      "sensitivity",
      "dynamics",
      "strike",
      "force",
      "exponent",
    ],
  },
  {
    id: "envelope_attack",
    tab: "sound",
    fine: true,
    shows: envelope,
    label: "Attack",
    group: "Envelope",
    words: ["envelope", "adsr", "onset", "fade in", "swell"],
  },
  {
    id: "envelope_decay",
    tab: "sound",
    fine: true,
    shows: envelope,
    label: "Decay",
    group: "Envelope",
    words: ["envelope", "adsr", "fall", "settle"],
  },
  {
    id: "envelope_sustain",
    tab: "sound",
    fine: true,
    shows: envelope,
    label: "Sustain",
    group: "Envelope",
    words: ["envelope", "adsr", "hold", "level", "body"],
  },
  {
    id: "envelope_release",
    tab: "sound",
    fine: true,
    shows: envelope,
    label: "Release",
    group: "Envelope",
    words: [
      "envelope",
      "adsr",
      "tail",
      "ring",
      "decay after",
      "fade out",
      "abrupt",
      "cut off",
    ],
  },
  {
    id: "effect_chain",
    tab: "sound",
    label: "Effect chain",
    words: [
      "reverb",
      "fx chain",
      "rack",
      "inserts",
      "effects bus",
      "plugin",
      "audio unit",
    ],
  },
  {
    id: "theme",
    tab: "look",
    label: "Theme",
    words: ["dark", "light", "appearance", "colour scheme"],
  },
  {
    id: "sheet_proportional",
    tab: "look",
    label: "Space notes by time",
    group: "Sheet",
    words: ["proportional", "even", "rhythm"],
  },
  {
    id: "sheet_spacing",
    tab: "look",
    label: "Spacing",
    group: "Sheet",
    words: ["zoom", "pinch", "width", "stretch"],
  },
  {
    id: "sheet_harmony",
    tab: "look",
    label: "Harmony",
    group: "Sheet",
    words: ["chords", "chord track", "roman numerals"],
  },
  {
    id: "sheet_colour",
    tab: "look",
    label: "Pitch colours",
    group: "Sheet",
    words: ["color", "rainbow", "notes"],
  },
  {
    id: "lane_lookahead",
    tab: "look",
    label: "Lookahead",
    group: "Falling notes",
    words: ["zoom", "pinch", "speed", "ahead"],
  },
  {
    id: "lane_note_width",
    tab: "look",
    label: "Note width",
    group: "Falling notes",
    words: ["block", "bar", "thickness"],
  },
  {
    id: "lane_gap",
    tab: "look",
    label: "Gap",
    group: "Falling notes",
    words: ["block", "space", "padding"],
  },
  {
    id: "lane_names",
    tab: "look",
    label: "Note names on blocks",
    group: "Falling notes",
    words: ["letters", "labels", "pitch"],
  },
  {
    id: "lane_harmony",
    tab: "look",
    label: "Harmony",
    group: "Falling notes",
    words: [
      "chords",
      "chord track",
      "roman numerals",
      "wheel",
      "circle of fifths",
    ],
  },
  {
    id: "keyboard_scale_marks",
    tab: "look",
    label: "Mark keys off the scale",
    group: "Keyboard",
    words: ["out of scale", "scale marks", "scale keyboard", "restrict"],
  },
  {
    id: "lane_colour",
    tab: "look",
    label: "Pitch colours",
    group: "Falling notes",
    words: ["color", "rainbow", "notes"],
  },
  {
    id: "keyboard_labels",
    tab: "look",
    label: "Note names on keys",
    group: "Keyboard",
    words: ["letters", "labels", "piano"],
  },
  {
    id: "keyboard_size",
    tab: "look",
    label: "Keyboard size",
    group: "Keyboard",
    words: ["keys", "range", "octaves", "88", "width", "custom"],
  },
  {
    id: "midi_device",
    tab: "midi",
    label: "Input device",
    words: ["midi", "keyboard", "piano", "port", "hidden", "bluetooth"],
  },
  {
    id: "matching_window_ms",
    tab: "playing",
    label: "Matching window",
    group: "Timing",
    words: ["hit window", "tolerance", "timing"],
  },
  {
    id: "togetherness_ms",
    tab: "playing",
    label: "Togetherness window",
    group: "Timing",
    words: ["chord", "spread", "together"],
  },
  {
    id: "play_inactive_hand",
    tab: "playing",
    label: "Inactive hand sounds",
    group: "Inactive hand",
    words: ["other hand", "ghost", "left", "right", "accompaniment"],
  },
  {
    id: "play_inactive_hand_velocity",
    tab: "playing",
    label: "Inactive hand velocity",
    group: "Inactive hand",
    words: ["other hand", "ghost", "dynamics", "follow", "loudness"],
  },
  {
    id: "play_inactive_hand_level",
    tab: "playing",
    label: "Inactive hand level",
    group: "Inactive hand",
    words: ["other hand", "ghost", "loudness", "softer"],
  },
  ...(import.meta.env.DEV
    ? [
        {
          id: "grade_tuning",
          tab: "playing" as const,
          label: "Grade tuning",
          words: ["score", "rating", "karaoke", "weight", "release"],
        },
        ...GRADE_KNOBS.map(([key, label]) => ({
          id: key,
          tab: "playing" as const,
          label,
          group: "Grade tuning",
          words: ["grade", "score", "rating", "karaoke", "tuning"],
        })),
      ]
    : []),
  {
    id: "library_folder",
    tab: "library",
    label: "Library folder",
    words: ["storage", "data directory", "scores", "files"],
  },
  {
    id: "pdmx_scores",
    tab: "library",
    label: "PDMX scores",
    words: ["download", "catalogue", "source", "provider"],
  },
] as const satisfies readonly RowShape[];

export type SettingRowId = (typeof SETTING_ROWS)[number]["id"];
export type SettingRow = RowShape & { id: SettingRowId };

/** The descriptor of one row. */
export function rowOf(id: SettingRowId): SettingRow {
  return SETTING_ROWS.find((row) => row.id === id)!;
}

/** The `id` a row's element carries, so a search result can scroll to it. Kept off the setting
 * keys so it collides with nothing. */
export function rowId(id: string): string {
  return `setting-row-${id}`;
}

/** The row a search result jumped to or the arrow keys walked onto, tinted until the next mark. */
export const markedRow = makeStore<SettingRowId | null>(null);

/** Whether `id` is the marked row. A row without an id is never marked. */
export function useMarked(id: SettingRowId | undefined): boolean {
  return useSyncExternalStore(
    markedRow.subscribe,
    () => id !== undefined && markedRow.get() === id,
  );
}
