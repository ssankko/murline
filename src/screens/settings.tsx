// The settings panel: a centred modal opened from every screen, holding everything the app does in
// general. What the open piece does right now is the play toolbar's. Every control writes on
// change; there is no Save.

import type { Envelope } from "@/audio/envelope";
import { SoundTab } from "@/audio/sound-tab";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { getSettingOr, readSettings, setSetting, type Settings } from "@/db/db";
import { type LaneHarmony, LOOKAHEAD_MAX, LOOKAHEAD_MIN } from "@/lane/lane";
import {
  cancelPdmx,
  downloadPdmx,
  progressLabel,
  usePdmxDownload,
} from "@/library/pdmx";
import { clamp, rowId } from "@/lib/utils";
import { noteName } from "@/score/pitch";
import { Loading } from "@/look/loading";
import { setTheme, type Theme } from "@/look/use-dark";
import { useMidiStatus } from "@/midi/use-midi-status";
import {
  INACTIVE_HAND_LEVEL,
  type InactiveHandVelocity,
  type KeyboardPreset,
} from "@/play/settings";
import { SPACING_MAX, SPACING_MIN, type Pinch } from "@/sheet/sheet";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Search } from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useRef, useState } from "react";

/** The whole keyboard, the span both note dropdowns offer. */
const NOTES = Array.from({ length: 88 }, (_, at) => 21 + at);

const THEMES: [Theme, string][] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

const HARMONY: [LaneHarmony, string][] = [
  ["panels", "Panels"],
  ["wheel", "Wheel"],
  ["off", "Off"],
];

const INACTIVE_HAND_VELOCITIES: [InactiveHandVelocity, string][] = [
  ["score", "From the score"],
  ["follow", "Follows you"],
];

const PRESETS: [KeyboardPreset, string][] = [
  ["piece", "Piece"],
  [25, "25"],
  [49, "49"],
  [61, "61"],
  [76, "76"],
  [88, "88"],
  ["custom", "Custom"],
];

/**
 * The eleven knobs that shape a Grade, each with the span and the step its slider takes.
 * Uncalibrated, so they ship only in a dev build.
 */
const GRADE_KNOBS: [
  key: keyof Settings,
  label: string,
  min: number,
  max: number,
  step: number,
][] = [
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
];

/** One global setting as it was just written: a key, with a value of that key's own type. */
export type SettingChange = {
  [K in keyof Settings]: [key: K, value: Settings[K]];
}[keyof Settings];

export type SettingsTab = "sound" | "look" | "playing" | "library";

const TAB_LABELS: Record<SettingsTab, string> = {
  sound: "Sound",
  look: "Look",
  playing: "Playing",
  library: "Library",
};

const TABS = Object.entries(TAB_LABELS) as [SettingsTab, string][];

/** Where a search result lives. The mixer and the MIDI devices are not tabs: they are the popovers
 * behind the bar's volume and MIDI buttons, and a result naming one of their controls opens that
 * popover instead of switching tab. */
type SearchWhere = SettingsTab | "mixer" | "midi";

const WHERE_LABELS: Record<SearchWhere, string> = {
  ...TAB_LABELS,
  mixer: "Volume",
  midi: "MIDI",
};

/** Whether a result lives on a tab of the panel rather than in a popover of its own. */
function isTab(where: SearchWhere): where is SettingsTab {
  return where in TAB_LABELS;
}

/**
 * Every row the search box can reach, declared here rather than read off the page, so a row on a
 * tab that is not open is still findable. `words` holds what a player types instead of the label,
 * seeded from the _Avoid_ lines of `CONTEXT.md`.
 *
 * A row belongs here only once the panel renders it. An entry for a row that is not on screen
 * sends the search to a tab with nothing on it, which is worse than finding nothing at all.
 *
 * `group` names the heading a row sits under, which the Look tab needs: its two Harmony rows and
 * its two Pitch colours rows are told apart by their heading and by nothing else.
 */
const SEARCH_ROWS: {
  id: string;
  tab: SearchWhere;
  label: string;
  group?: string;
  words: string[];
}[] = [
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
    words: ["latency", "delay", "lag", "block size", "samples"],
  },
  {
    id: "audio_sample_rate",
    tab: "sound",
    label: "Sample rate (Hz)",
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
    words: ["polyphony", "notes at once", "voice limit", "memory", "streaming"],
  },
  {
    id: "instrument_id",
    tab: "sound",
    label: "Instrument",
    words: ["patch", "preset", "voice", "sound font", "synth", "piano sound"],
  },
  {
    id: "instruments_folder",
    tab: "sound",
    label: "Instruments folder",
    words: ["sf2", "exs", "sound fonts", "samples"],
  },
  {
    id: "role_release",
    tab: "sound",
    label: "Release samples",
    group: "Roles",
    words: ["damper", "key up", "noise", "level"],
  },
  {
    id: "role_key_off",
    tab: "sound",
    label: "Key-off noise",
    group: "Roles",
    words: ["key up", "mechanism", "noise", "level"],
  },
  {
    id: "role_sympathetic",
    tab: "sound",
    label: "Sympathetic resonance",
    group: "Roles",
    words: ["strings", "ringing", "pedal", "noise", "level"],
  },
  {
    id: "role_pedal_noise",
    tab: "sound",
    label: "Pedal noise",
    group: "Roles",
    words: ["sustain pedal", "thump", "noise", "level"],
  },
  {
    id: "velocity_min",
    tab: "sound",
    label: "Minimum velocity",
    words: ["quiet", "floor", "softest", "soft", "dynamics", "touch"],
  },
  {
    id: "velocity_max",
    tab: "sound",
    label: "Maximum velocity",
    words: ["loud", "ceiling", "hardest", "top", "dynamics", "touch"],
  },
  {
    id: "velocity_curve",
    tab: "sound",
    label: "Velocity curve",
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
    label: "Attack",
    words: ["envelope", "adsr", "onset", "fade in", "swell"],
  },
  {
    id: "envelope_decay",
    tab: "sound",
    label: "Decay",
    words: ["envelope", "adsr", "fall", "settle"],
  },
  {
    id: "envelope_sustain",
    tab: "sound",
    label: "Sustain",
    words: ["envelope", "adsr", "hold", "level", "body"],
  },
  {
    id: "envelope_release",
    tab: "sound",
    label: "Release",
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
    label: "Lookahead (beats)",
    group: "Falling notes",
    words: ["zoom", "pinch", "speed", "ahead"],
  },
  {
    id: "lane_note_width",
    tab: "look",
    label: "Note width (%)",
    group: "Falling notes",
    words: ["block", "bar", "thickness"],
  },
  {
    id: "lane_gap",
    tab: "look",
    label: "Gap (px)",
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
    group: "Falling notes",
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
    group: "Falling notes",
    words: ["letters", "labels", "piano"],
  },
  {
    id: "keyboard_size",
    tab: "look",
    label: "Keyboard size",
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
    label: "Matching window (ms)",
    words: ["hit window", "tolerance", "timing"],
  },
  {
    id: "togetherness_ms",
    tab: "playing",
    label: "Togetherness window (ms)",
    words: ["chord", "spread", "together"],
  },
  {
    id: "play_inactive_hand",
    tab: "playing",
    label: "Inactive hand sounds",
    words: ["other hand", "ghost", "left", "right", "accompaniment"],
  },
  {
    id: "play_inactive_hand_velocity",
    tab: "playing",
    label: "Inactive hand velocity",
    words: ["other hand", "ghost", "dynamics", "follow", "loudness"],
  },
  {
    id: "play_inactive_hand_level",
    tab: "playing",
    label: "Inactive hand level (%)",
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
          id: key as string,
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
    id: "pdmx_folder",
    tab: "library",
    label: "PDMX folder",
    words: ["storage", "data directory"],
  },
  {
    id: "pdmx_scores",
    tab: "library",
    label: "PDMX scores",
    words: ["download", "catalogue", "source", "provider"],
  },
];

/**
 * The rows whose label, tab name or one of their words holds what was typed. `envelope` says
 * whether the instrument playing has an envelope to shape and `roles` whether it offers any of the
 * noises around its tone; a hosted plugin has neither, and the search must not offer rows the panel
 * is not showing.
 */
function searchRows(
  query: string,
  envelope: boolean,
  roles: boolean,
): typeof SEARCH_ROWS {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return SEARCH_ROWS.filter(
    (row) =>
      (envelope || !row.id.startsWith("envelope_")) &&
      (roles || !row.id.startsWith("role_")) &&
      [row.label, WHERE_LABELS[row.tab], row.group ?? "", ...row.words].some(
        (word) => word.toLowerCase().includes(needle),
      ),
  );
}

/**
 * Every app-wide setting, in four tabs, in a centred modal shaped like the score finder. The
 * overlay dims lighter than the finder's so the sheet and the lane behind stay legible and keep
 * animating while a control is moved. It reads nothing the play clock owns and writes nothing to
 * it.
 *
 * A knob the running play reads is handed to `onGlobalChange` as it is written, so a change
 * mid-practice applies at once.
 */
export function SettingsPanel({
  open,
  onClose,
  onGlobalChange,
  jumpTo,
  onOpenMixer,
  onOpenMidi,
}: {
  open: boolean;
  onClose: () => void;
  onGlobalChange?: (...change: SettingChange) => void;
  /** The way to the two faders, which are the mixer's and not the panel's. A search result naming
   * one closes the panel and opens the mixer over the button it belongs to. */
  onOpenMixer?: () => void;
  /** The same for the input devices, which are the MIDI popover's. */
  onOpenMidi?: () => void;
  /** A row to open on, named by its id: the same jump a search result makes, for the callers that
   * open the panel at one row rather than at the top. */
  jumpTo?: string | null;
}) {
  const [values, setValues] = useState<Settings | null>(null);
  const [tab, setTab] = useState<SettingsTab>("sound");
  const [query, setQuery] = useState("");
  /** Which search result the arrow keys are on. */
  const [sel, setSel] = useState(0);
  /** The row a search result jumped to, held until the next jump or the next open. */
  const [marked, setMarked] = useState<string | null>(null);
  /** Whether the instrument playing has an envelope, which is what puts its rows in the search. */
  const [envelope, setEnvelope] = useState(false);
  /** Whether it offers any role beyond the tone, which is what puts the four level rows there. */
  const [roles, setRoles] = useState(false);
  const [pdmxReady, setPdmxReady] = useState<boolean | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const column = useRef<HTMLDivElement>(null);
  /** The search box, whose keys are its own while its results stand and the marked row's after. */
  const box = useRef<HTMLInputElement>(null);
  /** How the mark is scrolled to: a search jump lands the row in the middle of the column, a mark
   * walked or clicked moves the column no further than it must. */
  const markScroll = useRef<ScrollLogicalPosition>("center");
  /** The stored offset waiting for the column to have rows to scroll; null once placed. */
  const [opensAt, setOpensAt] = useState<number | null>(null);
  const scrollWrite = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pdmx = usePdmxDownload();
  const downloading = pdmx.progress !== null;

  // Read again at every open, so the panel is in step with the popovers and with a finished PDMX
  // download, which writes the folder itself while nothing is listening.
  useEffect(() => {
    if (open) readSettings().then(setValues, console.error);
    else setMarked(null);
    if (open) {
      invoke<Envelope | null>("audio_envelope").then(
        (one) => setEnvelope(one !== null),
        () => setEnvelope(false),
      );
      invoke<{ roles?: string[] }>("audio_status").then(
        (status) => setRoles(!!status.roles?.length),
        () => setRoles(false),
      );
    }
  }, [open, downloading]);

  // The tab and the mark land in one render, as they do for a search result, so the scroll effect
  // below finds the row on the page.
  useEffect(() => {
    const row = jumpTo && SEARCH_ROWS.find((each) => each.id === jumpTo);
    if (!open || !row || !isTab(row.tab)) return;
    setTab(row.tab);
    setMarked(row.id);
  }, [open, jumpTo]);

  // Where the panel was left, taken up at every open. A `jumpTo` names the place instead, so the
  // stored one is passed over for that open.
  useEffect(() => {
    if (!open || jumpTo) return;
    let live = true;
    Promise.all([
      getSettingOr("settings_tab"),
      getSettingOr("settings_scroll"),
    ]).then(([last, offset]) => {
      if (!live) return;
      setTab(last);
      setOpensAt(offset);
    }, console.error);
    return () => {
      live = false;
    };
  }, [open, jumpTo]);

  // The rows arrive with `values` and the offset on its own read, in either order, and the column
  // can take the offset only once both are here.
  useEffect(() => {
    if (values && column.current && opensAt !== null) {
      column.current.scrollTop = opensAt;
      setOpensAt(null);
    }
  }, [values, opensAt]);

  // Whether the folder in force holds unpacked scores. Rust answers off the disk, not the setting.
  useEffect(() => {
    const folder = values?.pdmx_folder;
    if (folder === undefined) return;
    let live = true;
    const hold = (ready: boolean) => {
      if (live) setPdmxReady(ready);
    };
    invoke<boolean>("pdmx_status", { folder }).then(hold, () => hold(false));
    return () => {
      live = false;
    };
  }, [values?.pdmx_folder]);

  // The tab switch and the mark land in one render, so the row is on the page by the time this
  // runs. A row on a tab nobody has built yet is not in `SEARCH_ROWS`, so there is nothing to miss.
  useEffect(() => {
    if (marked)
      document
        .getElementById(rowId(marked))
        ?.scrollIntoView({ block: markScroll.current });
    markScroll.current = "center";
  }, [marked]);

  useEffect(() => {
    list.current
      ?.querySelector("[data-selected]")
      ?.scrollIntoView({ block: "nearest" });
  }, [sel, query]);

  /** Every tab opens at the top, so the offset held is the open tab's own. */
  function chooseTab(next: SettingsTab): void {
    setTab(next);
    setMarked(null);
    setOpensAt(null);
    if (column.current) column.current.scrollTop = 0;
    setSetting("settings_tab", next).catch(console.error);
    setSetting("settings_scroll", 0).catch(console.error);
  }

  // Scrolling writes far more often than the database is worth, so only the place a scroll rests
  // at is kept.
  function onScroll(event: React.UIEvent<HTMLDivElement>): void {
    const top = event.currentTarget.scrollTop;
    clearTimeout(scrollWrite.current);
    scrollWrite.current = setTimeout(() => {
      setSetting("settings_scroll", top).catch(console.error);
    }, 300);
  }

  function write<K extends keyof Settings>(key: K, value: Settings[K]): void {
    setValues((held) => held && { ...held, [key]: value });
    setSetting(key, value).catch(console.error);
    // The theme paints the whole app, so it is applied here rather than by whatever is behind.
    if (key === "theme") setTheme(value as Theme);
    // The pair comes straight out of this function's own key type, so it is one of the union.
    onGlobalChange?.(...([key, value] as SettingChange));
  }

  /** One line for the PDMX row: how far the download has got, or what is on disk. */
  const pdmxStatus = pdmx.progress
    ? progressLabel(pdmx.progress)
    : pdmxReady === null
      ? ""
      : pdmxReady
        ? "Ready"
        : "Not downloaded";

  async function chooseFolder(
    key: "library_folder" | "pdmx_folder",
  ): Promise<void> {
    const picked = await openDialog({
      directory: true,
      defaultPath: values?.[key] || undefined,
    });
    if (typeof picked === "string") write(key, picked);
  }

  const results = searchRows(query, envelope, roles);
  const selected = results[Math.min(sel, results.length - 1)] ?? null;

  function pick(row: (typeof SEARCH_ROWS)[number]): void {
    setQuery("");
    setSel(0);
    // A popover's control is not a row here, so the result hands the player to the popover rather
    // than to a tab that does not hold it.
    if (!isTab(row.tab)) {
      onClose();
      (row.tab === "mixer" ? onOpenMixer : onOpenMidi)?.();
      return;
    }
    chooseTab(row.tab);
    setMarked(row.id);
  }

  // The arrows belong to the results list alone: every slider, select and toggle on the tabs below
  // reads its own arrow keys, so the list must not take them from the whole modal. With no list up
  // the box holds no selection, and its keys are the marked row's.
  function onSearchKey(event: React.KeyboardEvent): void {
    if (query.trim() === "") return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSel((at) => Math.min(at + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSel((at) => Math.max(at - 1, 0));
    } else if (event.key === "Enter" && selected) {
      event.preventDefault();
      pick(selected);
    }
  }

  /**
   * The panel walked by keyboard: Up and Down move the mark through the rows of the open tab,
   * Space works the marked row's choice, Left and Right its slider. A held key repeats, so a
   * repeat is taken like any other press.
   */
  function onPanelKey(event: React.KeyboardEvent<HTMLDivElement>): void {
    // The results list and the tab strip answer first and mark what they took as spent.
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    // A select and a number field keep their own keys, and so does the search box while it has a
    // list under it.
    const own =
      target === box.current
        ? query.trim() !== ""
        : target.closest('select, textarea, input:not([type="range"])') !==
          null;
    if (own) return;

    const rows = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        '[id^="setting-row-"]',
      ),
    ]
      // A row of a tab that is not open is on the page but out of the walk.
      .filter((row) => row.offsetParent !== null);
    const at = rows.findIndex((row) => row.id === rowId(marked ?? ""));

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        rows[
          clamp(at + (event.key === "ArrowDown" ? 1 : -1), 0, rows.length - 1)
        ];
      if (!next) return;
      markScroll.current = "nearest";
      setMarked(next.id.slice(rowId("").length));
      return;
    }

    const row = rows[at];
    if (!row) return;
    if (event.key === " " && press(row)) event.preventDefault();
    const way =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (way !== 0 && slide(row, way, event.shiftKey)) event.preventDefault();
  }

  // A click or a tab into a control marks the row it sits in, so the keys carry on from there.
  function onPanelFocus(event: React.FocusEvent<HTMLDivElement>): void {
    const row = (event.target as HTMLElement).closest('[id^="setting-row-"]');
    if (!row) return;
    markScroll.current = "nearest";
    setMarked(row.id.slice(rowId("").length));
  }

  return (
    // Radix owns the overlay, the focus trap, Escape and the click outside. Its content carries
    // `role="dialog"` with `data-state="open"`, which is what the play screen's keys watch for:
    // while the panel is open, Space and Escape are the panel's and never reach the clock.
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        // Lighter than the finder's `bg-black/50`: the sheet and the lane behind have to stay
        // readable while a look setting is moved.
        overlayClassName="bg-black/20"
        className="top-[12%] flex max-h-[70vh] w-[640px] translate-y-0 flex-col gap-0 p-0 sm:max-w-[640px]"
        // On the content rather than on each row, so the keys work wherever focus sits inside.
        onKeyDown={onPanelKey}
        onFocus={onPanelFocus}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>

        <div className="border-edge-soft relative flex flex-none items-center gap-2.5 border-b px-4">
          <Search className="text-muted-ink size-4" />
          <input
            autoFocus
            ref={box}
            value={query}
            aria-label="Search settings"
            placeholder="Search settings"
            onChange={(event) => {
              setQuery(event.target.value);
              setSel(0);
            }}
            onKeyDown={onSearchKey}
            className="placeholder:text-muted-ink flex-1 bg-transparent py-3 text-[15px] outline-none"
          />
          {query.trim() !== "" && (
            <ul
              ref={list}
              className="bg-chrome border-edge-soft absolute inset-x-0 top-full z-10 max-h-64 overflow-y-auto border shadow-md"
            >
              {results.length === 0 && (
                <li className="text-muted-ink px-4 py-3 text-[12px]">
                  Nothing matches “{query}”.
                </li>
              )}
              {results.map((row, at) => (
                <li key={row.id}>
                  <button
                    data-selected={row === selected || undefined}
                    onMouseMove={() => sel !== at && setSel(at)}
                    onClick={() => pick(row)}
                    className={`flex w-full items-baseline gap-3 px-4 py-1.5 text-left text-[12px] ${
                      row === selected ? "bg-(--fill-selected)" : ""
                    }`}
                  >
                    <span className="min-w-0 truncate">{row.label}</span>
                    <span className="text-muted-ink ml-auto flex-none text-[11px]">
                      {row.group
                        ? `${WHERE_LABELS[row.tab]} · ${row.group}`
                        : WHERE_LABELS[row.tab]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Tabs.Root
          value={tab}
          onValueChange={(next) => chooseTab(next as SettingsTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <Tabs.List className="border-edge-soft flex flex-none gap-0.5 border-b px-4 pt-3">
            {TABS.map(([each, label]) => (
              <Tabs.Trigger
                key={each}
                value={each}
                className="text-muted-ink data-[state=active]:border-ink data-[state=active]:text-ink hover:text-ink -mb-px border-b-2 border-transparent px-2 pb-1.5 text-[12px] font-medium transition-colors duration-150"
              >
                {label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          {/* The box is a grid whose track is as wide as its widest content unless the column is let
            go under it: without min-w-0 a long path widens the whole panel. */}
          <div
            ref={column}
            onScroll={onScroll}
            className="flex min-w-0 flex-1 flex-col overflow-y-auto px-4 py-4"
          >
            {values && (
              <>
                {/* Radix makes every tab panel focusable, so a click in the body focuses the panel and
                  the next key rings every row at once. Its rows are all controls, so the
                  panel itself needs no place in the tab order. */}
                <Tabs.Content
                  value="sound"
                  className="flex flex-col gap-7"
                  tabIndex={undefined}
                >
                  {/* The sound engine's own settings write straight to it, not through `write`:
                    each one has to reach the running engine as well as the database. The two
                    volumes are not here at all; they are the mixer's two faders. */}
                  <SoundTab marked={marked} />
                </Tabs.Content>

                <Tabs.Content
                  value="look"
                  className="flex flex-col gap-6"
                  tabIndex={undefined}
                >
                  <Rows>
                    <Row id="theme" marked={marked === "theme"} label="Theme">
                      <Segmented
                        options={THEMES}
                        value={values.theme}
                        onChange={(value) => write("theme", value)}
                      />
                    </Row>
                  </Rows>

                  {/* Sheet and falling notes each carry their own harmony and their own colours, so
                    each heading names the view its rows move and nothing else. */}
                  <section className="flex flex-col gap-1.5">
                    <h3 className="text-muted-ink text-[11px] tracking-wide uppercase">
                      Sheet
                    </h3>
                    <Rows>
                      <Row
                        id="sheet_proportional"
                        marked={marked === "sheet_proportional"}
                        label="Space notes by time"
                      >
                        <Toggle
                          value={values.sheet_proportional}
                          onChange={(value) =>
                            write("sheet_proportional", value)
                          }
                        />
                      </Row>
                      <Row
                        id="sheet_spacing"
                        marked={marked === "sheet_spacing"}
                        label="Spacing"
                      >
                        <Slider
                          label="Sheet spacing in percent"
                          value={values.sheet_spacing}
                          min={SPACING_MIN}
                          max={SPACING_MAX}
                          step={5}
                          disabled={!values.sheet_proportional}
                          onChange={(value) => write("sheet_spacing", value)}
                        />
                      </Row>
                      <Row
                        id="sheet_harmony"
                        marked={marked === "sheet_harmony"}
                        label="Harmony"
                      >
                        <Toggle
                          value={values.sheet_harmony}
                          onChange={(value) => write("sheet_harmony", value)}
                        />
                      </Row>
                      <Row
                        id="sheet_colour"
                        marked={marked === "sheet_colour"}
                        label="Pitch colours"
                      >
                        <Toggle
                          value={values.sheet_colour}
                          onChange={(value) => write("sheet_colour", value)}
                        />
                      </Row>
                    </Rows>
                  </section>

                  <section className="flex flex-col gap-1.5">
                    <h3 className="text-muted-ink text-[11px] tracking-wide uppercase">
                      Falling notes
                    </h3>
                    <Rows>
                      <Row
                        id="lane_lookahead"
                        marked={marked === "lane_lookahead"}
                        label="Lookahead (beats)"
                      >
                        <Slider
                          label="Lane lookahead in beats"
                          value={values.lane_lookahead}
                          min={LOOKAHEAD_MIN}
                          max={LOOKAHEAD_MAX}
                          step={0.1}
                          onChange={(value) => write("lane_lookahead", value)}
                        />
                      </Row>
                      <Row
                        id="lane_note_width"
                        marked={marked === "lane_note_width"}
                        label="Note width (%)"
                      >
                        <Slider
                          label="Note width in percent"
                          value={values.lane_note_width}
                          min={10}
                          max={100}
                          step={1}
                          onChange={(value) => write("lane_note_width", value)}
                        />
                      </Row>
                      <Row
                        id="lane_gap"
                        marked={marked === "lane_gap"}
                        label="Gap (px)"
                      >
                        <Slider
                          label="Gap in pixels"
                          value={values.lane_gap}
                          min={0}
                          max={20}
                          step={1}
                          onChange={(value) => write("lane_gap", value)}
                        />
                      </Row>
                      <Row
                        id="lane_names"
                        marked={marked === "lane_names"}
                        label="Note names on blocks"
                      >
                        <Toggle
                          value={values.lane_names}
                          onChange={(value) => write("lane_names", value)}
                        />
                      </Row>
                      <Row
                        id="lane_harmony"
                        marked={marked === "lane_harmony"}
                        label="Harmony"
                      >
                        <Segmented
                          options={HARMONY}
                          value={values.lane_harmony}
                          onChange={(value) => write("lane_harmony", value)}
                        />
                      </Row>
                      <Row
                        id="lane_colour"
                        marked={marked === "lane_colour"}
                        label="Pitch colours"
                      >
                        <Toggle
                          value={values.lane_colour}
                          onChange={(value) => write("lane_colour", value)}
                        />
                      </Row>
                      <Row
                        id="keyboard_labels"
                        marked={marked === "keyboard_labels"}
                        label="Note names on keys"
                      >
                        <Toggle
                          value={values.keyboard_labels}
                          onChange={(value) => write("keyboard_labels", value)}
                        />
                      </Row>
                      <Row
                        id="keyboard_scale_marks"
                        marked={marked === "keyboard_scale_marks"}
                        label="Mark keys off the scale"
                      >
                        <Toggle
                          value={values.keyboard_scale_marks}
                          onChange={(value) =>
                            write("keyboard_scale_marks", value)
                          }
                        />
                      </Row>
                    </Rows>
                  </section>

                  {/* Keyboard size lays the keys out under the falling notes and changes nothing on
                    the sheet, so it sits outside that heading rather than under it. */}
                  <Rows>
                    <Row
                      id="keyboard_size"
                      marked={marked === "keyboard_size"}
                      label="Keyboard size"
                    >
                      <Segmented
                        options={PRESETS}
                        value={values.keyboard_preset}
                        onChange={(value) => write("keyboard_preset", value)}
                      />
                    </Row>
                    {values.keyboard_preset === "custom" && (
                      <Row label="Custom range">
                        <CustomRange
                          lo={values.keyboard_lo}
                          hi={values.keyboard_hi}
                          onChange={(lo, hi) => {
                            write("keyboard_lo", lo);
                            write("keyboard_hi", hi);
                          }}
                        />
                      </Row>
                    )}
                  </Rows>
                </Tabs.Content>

                <Tabs.Content
                  value="playing"
                  className="flex flex-col gap-7"
                  tabIndex={undefined}
                >
                  <Rows>
                    <Row
                      id="matching_window_ms"
                      marked={marked === "matching_window_ms"}
                      label="Matching window (ms)"
                    >
                      <Slider
                        label="Matching window in milliseconds"
                        value={values.matching_window_ms}
                        min={1}
                        max={1000}
                        step={1}
                        onChange={(value) => write("matching_window_ms", value)}
                      />
                    </Row>
                    <Row
                      id="togetherness_ms"
                      marked={marked === "togetherness_ms"}
                      label="Togetherness window (ms)"
                    >
                      <Slider
                        label="Togetherness window in milliseconds"
                        value={values.togetherness_ms}
                        min={1}
                        max={1000}
                        step={1}
                        onChange={(value) => write("togetherness_ms", value)}
                      />
                    </Row>
                    <Row
                      id="play_inactive_hand"
                      marked={marked === "play_inactive_hand"}
                      label="Inactive hand sounds"
                    >
                      <Toggle
                        value={values.play_inactive_hand}
                        onChange={(value) => write("play_inactive_hand", value)}
                      />
                    </Row>
                    <Row
                      id="play_inactive_hand_velocity"
                      marked={marked === "play_inactive_hand_velocity"}
                      label="Inactive hand velocity"
                    >
                      <Segmented
                        options={INACTIVE_HAND_VELOCITIES}
                        value={values.play_inactive_hand_velocity}
                        onChange={(value) =>
                          write("play_inactive_hand_velocity", value)
                        }
                      />
                    </Row>
                    <Row
                      id="play_inactive_hand_level"
                      marked={marked === "play_inactive_hand_level"}
                      label="Inactive hand level (%)"
                    >
                      <Slider
                        label="Inactive hand level in percent"
                        value={values.play_inactive_hand_level}
                        min={INACTIVE_HAND_LEVEL[0]}
                        max={INACTIVE_HAND_LEVEL[1]}
                        step={5}
                        onChange={(value) =>
                          write("play_inactive_hand_level", value)
                        }
                      />
                    </Row>
                  </Rows>

                  {import.meta.env.DEV && (
                    <details
                      id={rowId("grade_tuning")}
                      open={!!marked?.startsWith("grade_")}
                    >
                      <summary className="cursor-pointer text-[13px] font-semibold">
                        Grade tuning
                      </summary>
                      <p className="text-muted-ink mt-1 text-[11.5px]">
                        Grade normalises the three weights whatever they hold.
                      </p>
                      <div className="mt-3">
                        <Rows>
                          {GRADE_KNOBS.map(([key, label, min, max, step]) => (
                            <Row
                              key={key}
                              id={key}
                              marked={marked === key}
                              label={label}
                            >
                              <Slider
                                label={label}
                                value={values[key] as number}
                                min={min}
                                max={max}
                                step={step}
                                onChange={(value) => write(key, value as never)}
                              />
                            </Row>
                          ))}
                        </Rows>
                      </div>
                    </details>
                  )}
                </Tabs.Content>

                <Tabs.Content
                  value="library"
                  className="flex flex-col gap-2"
                  tabIndex={undefined}
                >
                  <p className="text-muted-ink text-[11.5px]">
                    A new library folder re-points the app. No file is moved.
                  </p>
                  <Rows>
                    <Row
                      id="library_folder"
                      marked={marked === "library_folder"}
                      label="Library folder"
                    >
                      <Path
                        value={values.library_folder}
                        onChoose={() =>
                          chooseFolder("library_folder").catch(console.error)
                        }
                      />
                    </Row>
                    <Row
                      id="pdmx_folder"
                      marked={marked === "pdmx_folder"}
                      label="PDMX folder"
                    >
                      <Path
                        value={values.pdmx_folder}
                        onChoose={() =>
                          chooseFolder("pdmx_folder").catch(console.error)
                        }
                      />
                    </Row>
                    <Row
                      id="pdmx_scores"
                      marked={marked === "pdmx_scores"}
                      label="PDMX scores"
                    >
                      <span className="flex flex-none flex-col items-end gap-0.5">
                        <span className="flex items-center gap-3">
                          <span className="text-muted-ink flex items-center gap-2 text-[12px] tabular-nums">
                            {pdmxStatus}
                            <Loading
                              on={downloading}
                              label="Downloading the PDMX scores"
                            />
                          </span>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 flex-none"
                            onClick={() => {
                              if (downloading) cancelPdmx();
                              else void downloadPdmx();
                            }}
                          >
                            {downloading ? "Cancel" : "Download (1.9 GB)"}
                          </Button>
                        </span>
                        {pdmx.error && (
                          <span className="text-[11px] text-red-600 dark:text-red-400">
                            {pdmx.error}
                          </span>
                        )}
                      </span>
                    </Row>
                  </Rows>
                </Tabs.Content>
              </>
            )}
          </div>
        </Tabs.Root>

        <footer className="border-edge-soft text-muted-ink flex flex-none justify-end gap-3 border-t px-4 py-2 text-[12px]">
          <span>↑↓ select</span>
          <span>↩ open</span>
          <span>esc close</span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Space on a row: presses the choice after the one pressed, wrapping, which flips a two-button
 * toggle and steps a longer set. False for a row that offers no choice, and Space stays the
 * browser's there.
 */
function press(row: HTMLElement): boolean {
  const buttons = [
    ...row.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
  ];
  if (buttons.length === 0) return false;
  const at = buttons.findIndex(
    (each) => each.getAttribute("aria-pressed") === "true",
  );
  buttons[(at + 1) % buttons.length]!.click();
  return true;
}

/**
 * Left and Right on a row: a twentieth of the slider's span, rounded to its step and never under
 * one step, or one step exactly when Shift is down and on the envelope and touch rows, whose every
 * step is worth hearing. False for a row with no slider to move.
 */
function slide(row: HTMLElement, way: 1 | -1, fine: boolean): boolean {
  const input = row.querySelector<HTMLInputElement>('input[type="range"]');
  // A row that folds other rows under it reaches their sliders as well; only its own answers.
  if (!input || input.disabled || input.closest('[id^="setting-row-"]') !== row)
    return false;
  const min = Number(input.min);
  const max = Number(input.max);
  const step = Number(input.step) || 1;
  const jump =
    fine || /^setting-row-(envelope|velocity)_/.test(row.id)
      ? step
      : Math.max(step, Math.round(((max - min) * 0.05) / step) * step);
  const next = clamp(Number(input.value) + way * jump, min, max);
  // React holds the value it last rendered, and swallows a plain assignment as no change. The
  // native setter with an `input` event is the same arrival as a drag, so the row's own handler
  // writes the setting.
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, String(next));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

/** Paper kept between the fingers and the panel a pinch raises, and from the window's edges. */
const PINCH_GAP = 12;
const PINCH_W = 200;
const PINCH_H = 40;

/**
 * What a pinch on the sheet is choosing, shown at the fingers while they move: the spacing the
 * sheet will be drawn at once they stop. It takes no input; the fingers are the control. The panel
 * holds its last place and value while it fades away, so `null` reads as the end of the pinch.
 */
export function SpacingPopup({ pinch }: { pinch: Pinch | null }) {
  const [held, setHeld] = useState<Pinch | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!pinch) {
      setShown(false);
      return;
    }
    setHeld(pinch);
    // The fade starts on the frame after the panel is on the page, so it has a state to leave.
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [pinch]);

  if (!held) return null;
  return (
    <div
      role="status"
      aria-label="Sheet spacing"
      style={{
        left: clamp(
          held.x + PINCH_GAP,
          PINCH_GAP,
          window.innerWidth - PINCH_W - PINCH_GAP,
        ),
        top: clamp(
          held.y + PINCH_GAP,
          PINCH_GAP,
          window.innerHeight - PINCH_H - PINCH_GAP,
        ),
        width: PINCH_W,
      }}
      className={`bg-chrome border-edge-soft pointer-events-none fixed z-50 flex items-center gap-2 rounded-md border px-3 py-2 text-[12px] shadow-md transition-opacity duration-150 ease-[var(--ease)] ${shown ? "opacity-100" : "opacity-0"}`}
    >
      {/* The track only draws the target; the readout beside it is what a reader is told. */}
      <input
        type="range"
        readOnly
        tabIndex={-1}
        aria-hidden
        min={SPACING_MIN}
        max={SPACING_MAX}
        value={held.spacing}
        className="accent-ink min-w-0 flex-1"
      />
      <span className="w-10 flex-none text-right tabular-nums">
        {held.spacing} %
      </span>
    </div>
  );
}

/** The divided list the panel's rows sit in. */
function Rows({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-edge-soft border-edge-soft divide-y border-y">
      {children}
    </div>
  );
}

function Row({
  id,
  label,
  hint,
  marked,
  children,
}: {
  /** Set on a panel row, so a search result can scroll to it and mark it. */
  id?: string;
  label: string;
  hint?: string;
  marked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id && rowId(id)}
      data-marked={marked || undefined}
      className={`flex min-h-8 items-center justify-between gap-3 py-1 text-[12px] ${marked ? "bg-ink/8" : ""}`}
    >
      <span className={hint ? "flex flex-col gap-0.5" : "flex-none"}>
        {label}
        {hint && (
          <span className="text-muted-ink text-[11px] leading-snug">
            {hint}
          </span>
        )}
      </span>
      {children}
    </div>
  );
}

function Path({ value, onChoose }: { value: string; onChoose: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="text-muted-ink truncate text-[11.5px] select-text">
        {value || "not set"}
      </code>
      <Button
        variant="outline"
        size="sm"
        className="h-7 flex-none"
        onClick={onChoose}
      >
        Choose…
      </Button>
    </div>
  );
}

/** A number dragged rather than typed, with its value beside it. A pinch moves one of these. */
function Slider({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <span className="flex flex-none items-center gap-2">
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="accent-ink w-24 disabled:opacity-30"
      />
      <span className="text-muted-ink w-8 text-right text-[11px] tabular-nums">
        {value}
      </span>
    </span>
  );
}

function Toggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Segmented
      options={[
        [true, "On"],
        [false, "Off"],
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

/** The one shape every choice of a few takes: the active one filled with ink. */
function Segmented<T extends string | number | boolean>({
  options,
  value,
  onChange,
}: {
  options: [T, string][];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="border-edge flex flex-none border">
      {options.map(([each, label]) => (
        <button
          key={String(each)}
          aria-pressed={value === each}
          onClick={() => onChange(each)}
          className={`h-6 px-2 text-[11.5px] font-medium transition-colors duration-150 ${
            value === each ? "bg-ink text-paper" : "hover:bg-ink/8"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * A custom keyboard range: the two ends, and the two strikes that read them off the keyboard. The
 * next strike is the low end, the one after it the high end, in whichever order they come.
 */
function CustomRange({
  lo,
  hi,
  onChange,
}: {
  lo: number;
  hi: number;
  onChange: (lo: number, hi: number) => void;
}) {
  /** The first of the two strikes "Detect from keyboard" is waiting for, if it has come. */
  const [detecting, setDetecting] = useState<{ first: number | null } | null>(
    null,
  );

  useMidiStatus((event) => {
    if (!detecting || !event.on) return;
    if (detecting.first === null) return setDetecting({ first: event.midi });
    setDetecting(null);
    onChange(
      Math.min(detecting.first, event.midi),
      Math.max(detecting.first, event.midi),
    );
  });

  return (
    <div className="flex flex-none flex-col items-start gap-1.5">
      {/* The low end never passes the high one. */}
      <div className="flex flex-none items-center gap-1.5">
        <NoteSelect
          label="Lowest key"
          value={lo}
          onChange={(next) => onChange(next, Math.max(next, hi))}
        />
        <span className="text-muted-ink text-[12px]">to</span>
        <NoteSelect
          label="Highest key"
          value={hi}
          onChange={(next) => onChange(Math.min(lo, next), next)}
        />
      </div>
      <button
        onClick={() => setDetecting({ first: null })}
        className="text-muted-ink hover:text-ink text-[12px] underline underline-offset-2"
      >
        {detecting
          ? detecting.first === null
            ? "Strike the lowest and the highest key…"
            : "Now the other end…"
          : "Detect from keyboard"}
      </button>
    </div>
  );
}

function NoteSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className="border-edge h-7 border bg-transparent px-1.5 text-[12px]"
    >
      {NOTES.map((midi) => (
        <option key={midi} value={midi}>
          {noteName(midi)}
        </option>
      ))}
    </select>
  );
}
