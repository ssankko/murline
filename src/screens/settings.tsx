// The settings panel: a centred modal opened from every screen, holding everything the app does in
// general. What the open piece does right now is the play toolbar's. Every control writes on
// change; there is no Save.

import { SoundTab } from "@/audio/sound-tab";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  set,
  setting,
  useSettings,
  type Settings,
} from "@/settings/settings";
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
import { Row, Rows, Segmented, Toggle } from "@/look/rows";
import type { Theme } from "@/look/use-dark";
import { useMidiStatus } from "@/midi/use-midi-status";
import {
  INACTIVE_HAND_LEVEL,
  type InactiveHandVelocity,
  type KeyboardPreset,
} from "@/play/settings";
import { SPACING_MAX, SPACING_MIN, type Pinch } from "@/sheet/sheet";
import { call } from "@/rust";
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
    group: "Touch",
    words: ["quiet", "floor", "softest", "soft", "dynamics", "touch"],
  },
  {
    id: "velocity_max",
    tab: "sound",
    label: "Maximum velocity",
    group: "Touch",
    words: ["loud", "ceiling", "hardest", "top", "dynamics", "touch"],
  },
  {
    id: "velocity_curve",
    tab: "sound",
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
    label: "Attack",
    group: "Envelope",
    words: ["envelope", "adsr", "onset", "fade in", "swell"],
  },
  {
    id: "envelope_decay",
    tab: "sound",
    label: "Decay",
    group: "Envelope",
    words: ["envelope", "adsr", "fall", "settle"],
  },
  {
    id: "envelope_sustain",
    tab: "sound",
    label: "Sustain",
    group: "Envelope",
    words: ["envelope", "adsr", "hold", "level", "body"],
  },
  {
    id: "envelope_release",
    tab: "sound",
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
 * A knob the running play reads reaches the live objects through the store, so a change
 * mid-practice applies at once.
 */
export function SettingsPanel({
  open,
  onClose,
  jumpTo,
  onOpenMixer,
  onOpenMidi,
}: {
  open: boolean;
  onClose: () => void;
  /** The way to the two faders, which are the mixer's and not the panel's. A search result naming
   * one closes the panel and opens the mixer over the button it belongs to. */
  onOpenMixer?: () => void;
  /** The same for the input devices, which are the MIDI popover's. */
  onOpenMidi?: () => void;
  /** A row to open on, named by its id: the same jump a search result makes, for the callers that
   * open the panel at one row rather than at the top. */
  jumpTo?: string | null;
}) {
  const values = useSettings();
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

  // What the loaded instrument offers is asked at every open, so the search reaches the rows the
  // engine is putting on the page now.
  useEffect(() => {
    if (!open) {
      setMarked(null);
      setQuery("");
      setSel(0);
    }
    if (open) {
      call("audio_envelope").then(
        (one) => setEnvelope(one !== null),
        () => setEnvelope(false),
      );
      call("audio_status").then(
        (status) => setRoles(status.roles.length > 0),
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
    setTab(setting("settings_tab"));
    setOpensAt(setting("settings_scroll"));
  }, [open, jumpTo]);

  // The column takes the offset once it is on the page, which is the render after the open.
  useEffect(() => {
    if (column.current && opensAt !== null) {
      column.current.scrollTop = opensAt;
      setOpensAt(null);
    }
  }, [opensAt]);

  // Nothing of this panel writes once it is gone.
  useEffect(() => () => clearTimeout(scrollWrite.current), []);

  // Whether the tarball is unpacked. Rust answers off the disk and owns the folder it looks in,
  // so the answer is asked for once per open of the panel.
  useEffect(() => {
    let live = true;
    const hold = (ready: boolean) => {
      if (live) setPdmxReady(ready);
    };
    call("pdmx_status").then(hold, () => hold(false));
    return () => {
      live = false;
    };
  }, [open]);

  // The tab switch and the mark land in one render, so a mark set as the panel opens is scrolled
  // to once the row is on the page. A row on a tab nobody has built yet is not in `SEARCH_ROWS`,
  // so there is nothing to miss.
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

  /** Every tab opens at the top, so the offset held is the open tab's own. A write still resting
   * behind the old tab's scrolling would land after this one, so it is dropped. */
  function chooseTab(next: SettingsTab): void {
    clearTimeout(scrollWrite.current);
    setTab(next);
    setMarked(null);
    setOpensAt(null);
    if (column.current) column.current.scrollTop = 0;
    void set("settings_tab", next);
    void set("settings_scroll", 0);
  }

  // Scrolling writes far more often than the setting is worth, so only the place a scroll rests
  // at is kept.
  function onScroll(event: React.UIEvent<HTMLDivElement>): void {
    const top = event.currentTarget.scrollTop;
    clearTimeout(scrollWrite.current);
    scrollWrite.current = setTimeout(() => {
      void set("settings_scroll", top);
    }, 300);
  }

  /** One line for the PDMX row: how far the download has got, or what is on disk. */
  const pdmxStatus = pdmx.progress
    ? progressLabel(pdmx.progress)
    : pdmxReady === null
      ? ""
      : pdmxReady
        ? "Ready"
        : "Not downloaded";

  async function chooseFolder(key: "library_folder"): Promise<void> {
    const at = values[key];
    const picked = await openDialog({ directory: true, ...(at ? { defaultPath: at } : {}) });
    if (typeof picked === "string") void set(key, picked);
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

  /** The `id` and `marked` every `Row` takes, spread instead of repeated at each call site. */
  const markRow = (id: string) => ({ id, marked: marked === id });

  /** The `value` and `onChange` every control writing straight to one setting takes. */
  function bind<K extends keyof Settings>(key: K) {
    return { value: values[key], onChange: (value: Settings[K]) => void set(key, value) };
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
            {/* Radix makes every tab panel focusable, so a click in the body focuses the panel and
              the next key rings every row at once. Its rows are all controls, so the
              panel itself needs no place in the tab order. */}
            <Tabs.Content
              value="sound"
              className="flex flex-col gap-7"
              tabIndex={undefined}
            >
              {/* The two volumes are not here at all; they are the mixer's two faders. */}
              <SoundTab marked={marked} />
            </Tabs.Content>

            <Tabs.Content
              value="look"
              className="flex flex-col gap-6"
              tabIndex={undefined}
            >
              <Rows>
                <Row {...markRow("theme")} label="Theme">
                  <Segmented options={THEMES} {...bind("theme")} />
                </Row>
              </Rows>

              {/* Sheet and falling notes each carry their own harmony and their own colours, so
                each heading names the view its rows move and nothing else. */}
              <Section title="Sheet">
                <Rows>
                  <Row
                    {...markRow("sheet_proportional")}
                    label="Space notes by time"
                    hint="Off keeps the engraving's own spacing."
                  >
                    <Toggle {...bind("sheet_proportional")} />
                  </Row>
                  <Row
                    {...markRow("sheet_spacing")}
                    label="Spacing"
                    hint="A pinch on the sheet moves it too."
                  >
                    <Slider
                      label="Sheet spacing in percent"
                      unit="%"
                      min={SPACING_MIN}
                      max={SPACING_MAX}
                      step={5}
                      disabled={!values.sheet_proportional}
                      {...bind("sheet_spacing")}
                    />
                  </Row>
                  <Row
                    {...markRow("sheet_harmony")}
                    label="Harmony"
                    hint="Names the chord at the cursor and the two after it."
                  >
                    <Toggle {...bind("sheet_harmony")} />
                  </Row>
                  <Row {...markRow("sheet_colour")} label="Pitch colours">
                    <Toggle {...bind("sheet_colour")} />
                  </Row>
                </Rows>
              </Section>

              <Section title="Falling notes">
                <Rows>
                  <Row
                    {...markRow("lane_lookahead")}
                    label="Lookahead"
                    hint="How many beats are in view at once."
                  >
                    <Slider
                      label="Lane lookahead in beats"
                      unit=" beats"
                      min={LOOKAHEAD_MIN}
                      max={LOOKAHEAD_MAX}
                      step={0.1}
                      {...bind("lane_lookahead")}
                    />
                  </Row>
                  <Row
                    {...markRow("lane_note_width")}
                    label="Note width"
                    hint="Part of its key's width."
                  >
                    <Slider
                      label="Note width in percent"
                      unit="%"
                      min={10}
                      max={100}
                      step={1}
                      {...bind("lane_note_width")}
                    />
                  </Row>
                  <Row
                    {...markRow("lane_gap")}
                    label="Gap"
                    hint="Cut between two blocks that follow each other."
                  >
                    <Slider
                      label="Gap in pixels"
                      unit=" px"
                      min={0}
                      max={20}
                      step={1}
                      {...bind("lane_gap")}
                    />
                  </Row>
                  <Row
                    {...markRow("lane_names")}
                    label="Note names on blocks"
                  >
                    <Toggle {...bind("lane_names")} />
                  </Row>
                  <Row
                    {...markRow("lane_harmony")}
                    label="Harmony"
                    hint="Chord names at the lane's top right."
                  >
                    <Segmented options={HARMONY} {...bind("lane_harmony")} />
                  </Row>
                  <Row {...markRow("lane_colour")} label="Pitch colours">
                    <Toggle {...bind("lane_colour")} />
                  </Row>
                </Rows>
              </Section>

              {/* The keys drawn under the falling notes, which the sheet knows nothing of. */}
              <Section title="Keyboard">
                <Rows>
                  <Row
                    {...markRow("keyboard_labels")}
                    label="Note names on keys"
                  >
                    <Toggle {...bind("keyboard_labels")} />
                  </Row>
                  <Row
                    {...markRow("keyboard_scale_marks")}
                    label="Mark keys off the scale"
                    hint="Ghosts what the key in force does not hold."
                  >
                    <Toggle {...bind("keyboard_scale_marks")} />
                  </Row>
                  <Row
                    {...markRow("keyboard_size")}
                    label="Keyboard size"
                    hint="Keys the lane draws under the falling notes."
                  >
                    <Segmented options={PRESETS} {...bind("keyboard_preset")} />
                  </Row>
                  {values.keyboard_preset === "custom" && (
                    <Row label="Custom range">
                      <CustomRange
                        lo={values.keyboard_lo}
                        hi={values.keyboard_hi}
                        onChange={(lo, hi) => {
                          void set("keyboard_lo", lo);
                          void set("keyboard_hi", hi);
                        }}
                      />
                    </Row>
                  )}
                </Rows>
              </Section>
            </Tabs.Content>

            <Tabs.Content
              value="playing"
              className="flex flex-col gap-7"
              tabIndex={undefined}
            >
              <Section title="Timing">
                <Rows>
                  <Row
                    {...markRow("matching_window_ms")}
                    label="Matching window"
                    hint="How far off the beat a strike still counts."
                  >
                    <Slider
                      label="Matching window in milliseconds"
                      unit=" ms"
                      min={1}
                      max={1000}
                      step={1}
                      {...bind("matching_window_ms")}
                    />
                  </Row>
                  <Row
                    {...markRow("togetherness_ms")}
                    label="Togetherness window"
                    hint="How far apart the notes of one chord may be struck."
                  >
                    <Slider
                      label="Togetherness window in milliseconds"
                      unit=" ms"
                      min={1}
                      max={1000}
                      step={1}
                      {...bind("togetherness_ms")}
                    />
                  </Row>
                </Rows>
              </Section>

              {/* The velocity and the level shape a sound nothing makes while the first row is
                off, so both stand dead until it is on. */}
              <Section title="Inactive hand">
                <Rows>
                  <Row
                    {...markRow("play_inactive_hand")}
                    label="Inactive hand sounds"
                    hint="Played as the clock passes it."
                  >
                    <Toggle {...bind("play_inactive_hand")} />
                  </Row>
                  <Row
                    {...markRow("play_inactive_hand_velocity")}
                    label="Inactive hand velocity"
                    hint="Loudness from the written dynamics, or from your strikes."
                  >
                    <Segmented
                      options={INACTIVE_HAND_VELOCITIES}
                      disabled={!values.play_inactive_hand}
                      {...bind("play_inactive_hand_velocity")}
                    />
                  </Row>
                  <Row
                    {...markRow("play_inactive_hand_level")}
                    label="Inactive hand level"
                    hint="Part of that loudness it sounds at."
                  >
                    <Slider
                      label="Inactive hand level in percent"
                      unit="%"
                      min={INACTIVE_HAND_LEVEL[0]}
                      max={INACTIVE_HAND_LEVEL[1]}
                      step={5}
                      disabled={!values.play_inactive_hand}
                      {...bind("play_inactive_hand_level")}
                    />
                  </Row>
                </Rows>
              </Section>

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
                        <Row key={key} {...markRow(key)} label={label}>
                          <Slider
                            label={label}
                            value={values[key] as number}
                            min={min}
                            max={max}
                            step={step}
                            onChange={(value) => void set(key, value as never)}
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
                  {...markRow("library_folder")}
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
                  {...markRow("pdmx_scores")}
                  label="PDMX scores"
                  hint="The score finder needs them to offer PDMX rows."
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
          </div>
        </Tabs.Root>

        {/* Enter belongs to the results list alone; with no list up the keys are the marked row's. */}
        <footer className="border-edge-soft text-muted-ink flex flex-none justify-end gap-3 border-t px-4 py-2 text-[12px]">
          {query.trim() === "" ? (
            <>
              <span>↑↓ move</span>
              <span>space change</span>
              <span>←→ adjust</span>
            </>
          ) : (
            <>
              <span>↑↓ select</span>
              <span>↩ open</span>
            </>
          )}
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

/** One heading over one group of rows, on the Look and Playing tabs. */
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {children}
    </section>
  );
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
        {held.spacing}%
      </span>
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

/**
 * A number dragged rather than typed, with its value beside it. A pinch moves one of these. `unit`
 * is appended to the readout as it is written, so a per cent carries no space and a millisecond
 * does.
 */
function Slider({
  label,
  value,
  unit = "",
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  unit?: string;
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
      <span className="text-muted-ink w-14 flex-none text-right text-[11px] whitespace-nowrap tabular-nums">
        {value}
        {unit}
      </span>
    </span>
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
