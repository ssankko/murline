// The settings panel: a right-hand slide-over opened from every screen, holding everything the app
// does in general. What the open piece does right now is the play toolbar's. Every control writes
// on change; there is no Save.

import { SoundTab } from '@/audio/sound-tab';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { readSettings, setSetting, type Settings } from '@/db/db';
import { LOOKAHEAD_MAX, LOOKAHEAD_MIN } from '@/lane/lane';
import { cancelPdmx, downloadPdmx, progressLabel, usePdmxDownload } from '@/library/pdmx';
import { clamp, rowId } from '@/lib/utils';
import { noteName } from '@/look/color';
import { setTheme, type Theme } from '@/look/use-dark';
import { pinMidiDevice, useMidiStatus } from '@/midi/use-midi-status';
import { validNumber } from '@/play/resolve';
import { type KeyboardPreset } from '@/play/settings';
import { SPACING_MAX, SPACING_MIN, type Pinch } from '@/sheet/sheet';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { ChevronDown, X } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';

/** The whole keyboard, the span both note dropdowns offer. */
const NOTES = Array.from({ length: 88 }, (_, at) => 21 + at);

const THEMES: [Theme, string][] = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

const PRESETS: [KeyboardPreset, string][] = [
  ['piece', 'Piece'],
  [25, '25'],
  [49, '49'],
  [61, '61'],
  [76, '76'],
  [88, '88'],
  ['custom', 'Custom'],
];

/** The eleven knobs that shape a Grade. Uncalibrated, so they ship only in a dev build. */
const GRADE_KNOBS: [keyof Settings, string, number, number][] = [
  ['grade_weight_timing', 'Timing weight', 0, 1],
  ['grade_weight_velocity', 'Velocity weight', 0, 1],
  ['grade_weight_release', 'Release weight', 0, 1],
  ['grade_timing_flat_ms', 'Timing full marks (ms)', 0, 500],
  ['grade_timing_zero_ms', 'Timing zero (ms)', 1, 2000],
  ['grade_velocity_flat', 'Velocity full marks', 0, 127],
  ['grade_velocity_zero', 'Velocity zero', 1, 127],
  ['grade_release_flat_lo', 'Release full marks from', 0, 10],
  ['grade_release_flat_hi', 'Release full marks to', 0, 10],
  ['grade_release_zero_lo', 'Release zero below', 0, 10],
  ['grade_release_zero_hi', 'Release zero above', 0, 10],
];

/** One global setting as it was just written: a key, with a value of that key's own type. */
export type SettingChange = { [K in keyof Settings]: [key: K, value: Settings[K]] }[keyof Settings];

type SettingsTab = 'sound' | 'look' | 'playing' | 'library';

const TAB_LABELS: Record<SettingsTab, string> = {
  sound: 'Sound',
  look: 'Look',
  playing: 'Playing',
  library: 'Library',
};

const TABS = Object.entries(TAB_LABELS) as [SettingsTab, string][];

/** Where a search result lives. The mixer is not a tab: it is the popover behind the volume
 * button, and a result naming one of its faders opens it instead of switching tab. */
type SearchWhere = SettingsTab | 'mixer';

const WHERE_LABELS: Record<SearchWhere, string> = { ...TAB_LABELS, mixer: 'Volume' };

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
    id: 'keyboard_volume',
    tab: 'mixer',
    label: 'Keyboard',
    words: ['volume', 'loudness', 'gain', 'level', 'quiet', 'night', 'master'],
  },
  {
    id: 'click_volume',
    tab: 'mixer',
    label: 'Metronome',
    words: ['volume', 'loudness', 'click', 'beat', 'level'],
  },
  {
    id: 'audio_output_device',
    tab: 'sound',
    label: 'Output device',
    words: ['speakers', 'headphones', 'interface', 'sound card', 'playback engine'],
  },
  {
    id: 'audio_buffer_frames',
    tab: 'sound',
    label: 'Buffer (frames)',
    words: ['latency', 'delay', 'lag', 'block size', 'samples'],
  },
  {
    id: 'instrument_id',
    tab: 'sound',
    label: 'Instrument',
    words: ['patch', 'preset', 'voice', 'sound font', 'synth', 'piano sound'],
  },
  {
    id: 'instruments_folder',
    tab: 'sound',
    label: 'Instruments folder',
    words: ['sf2', 'exs', 'sound fonts', 'samples'],
  },
  {
    id: 'velocity_floor',
    tab: 'sound',
    label: 'Softest note volume',
    words: ['quiet', 'floor', 'minimum', 'soft', 'dynamics', 'touch'],
  },
  {
    id: 'velocity_curve',
    tab: 'sound',
    label: 'Velocity curve',
    words: ['touch', 'response', 'sensitivity', 'dynamics', 'strike', 'force', 'exponent'],
  },
  {
    id: 'effect_chain',
    tab: 'sound',
    label: 'Effect chain',
    words: ['reverb', 'fx chain', 'rack', 'inserts', 'effects bus', 'plugin', 'audio unit'],
  },
  {
    id: 'theme',
    tab: 'look',
    label: 'Theme',
    words: ['dark', 'light', 'appearance', 'colour scheme'],
  },
  {
    id: 'sheet_proportional',
    tab: 'look',
    label: 'Space notes by time',
    group: 'Sheet',
    words: ['proportional', 'even', 'rhythm'],
  },
  {
    id: 'sheet_spacing',
    tab: 'look',
    label: 'Spacing',
    group: 'Sheet',
    words: ['zoom', 'pinch', 'width', 'stretch'],
  },
  {
    id: 'sheet_harmony',
    tab: 'look',
    label: 'Harmony',
    group: 'Sheet',
    words: ['chords', 'chord track', 'roman numerals'],
  },
  {
    id: 'sheet_colour',
    tab: 'look',
    label: 'Pitch colours',
    group: 'Sheet',
    words: ['color', 'rainbow', 'notes'],
  },
  {
    id: 'lane_lookahead',
    tab: 'look',
    label: 'Lookahead (beats)',
    group: 'Falling notes',
    words: ['zoom', 'pinch', 'speed', 'ahead'],
  },
  {
    id: 'lane_note_width',
    tab: 'look',
    label: 'Note width (%)',
    group: 'Falling notes',
    words: ['block', 'bar', 'thickness'],
  },
  {
    id: 'lane_gap',
    tab: 'look',
    label: 'Gap (px)',
    group: 'Falling notes',
    words: ['block', 'space', 'padding'],
  },
  {
    id: 'lane_names',
    tab: 'look',
    label: 'Note names on blocks',
    group: 'Falling notes',
    words: ['letters', 'labels', 'pitch'],
  },
  {
    id: 'lane_harmony',
    tab: 'look',
    label: 'Harmony',
    group: 'Falling notes',
    words: ['chords', 'chord track', 'roman numerals'],
  },
  {
    id: 'lane_colour',
    tab: 'look',
    label: 'Pitch colours',
    group: 'Falling notes',
    words: ['color', 'rainbow', 'notes'],
  },
  {
    id: 'keyboard_labels',
    tab: 'look',
    label: 'Note names on keys',
    group: 'Falling notes',
    words: ['letters', 'labels', 'piano'],
  },
  {
    id: 'keyboard_size',
    tab: 'look',
    label: 'Keyboard size',
    words: ['keys', 'range', 'octaves', '88', 'width', 'custom'],
  },
  {
    id: 'midi_device',
    tab: 'playing',
    label: 'Input device',
    words: ['midi', 'keyboard', 'piano', 'port'],
  },
  {
    id: 'velocity_offset',
    tab: 'playing',
    label: 'Velocity offset',
    words: ['touch', 'strike', 'force', 'loudness'],
  },
  {
    id: 'matching_window_ms',
    tab: 'playing',
    label: 'Matching window (ms)',
    words: ['hit window', 'tolerance', 'timing'],
  },
  {
    id: 'togetherness_ms',
    tab: 'playing',
    label: 'Togetherness window (ms)',
    words: ['chord', 'spread', 'together'],
  },
  ...(import.meta.env.DEV
    ? [
        {
          id: 'grade_tuning',
          tab: 'playing' as const,
          label: 'Grade tuning',
          words: ['score', 'rating', 'karaoke', 'weight', 'release'],
        },
      ]
    : []),
  {
    id: 'library_folder',
    tab: 'library',
    label: 'Library folder',
    words: ['storage', 'data directory', 'scores', 'files'],
  },
  {
    id: 'pdmx_folder',
    tab: 'library',
    label: 'PDMX folder',
    words: ['storage', 'data directory'],
  },
  {
    id: 'pdmx_scores',
    tab: 'library',
    label: 'PDMX scores',
    words: ['download', 'catalogue', 'source', 'provider'],
  },
];

/** The rows whose label, tab name or one of their words holds what was typed. */
function searchRows(query: string): typeof SEARCH_ROWS {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return SEARCH_ROWS.filter((row) =>
    [row.label, WHERE_LABELS[row.tab], row.group ?? '', ...row.words].some((word) =>
      word.toLowerCase().includes(needle),
    ),
  );
}

/**
 * Every app-wide setting, in four tabs, over whatever screen is behind it. The panel is not modal:
 * the sheet and the lane stay visible and keep animating while a control is moved, so a change can
 * be judged by eye and ear. It reads nothing the play clock owns and writes nothing to it.
 *
 * A knob the running play reads is handed to `onGlobalChange` as it is written, so a change
 * mid-practice applies at once. `live` is the way back: a setting the screen behind the panel has
 * just changed itself, which is how a pinch on the lane or the sheet moves its own row.
 */
export function SettingsPanel({
  open,
  onClose,
  onGlobalChange,
  live,
  jumpTo,
  onOpenMixer,
}: {
  open: boolean;
  onClose: () => void;
  onGlobalChange?: (...change: SettingChange) => void;
  live?: SettingChange | null;
  /** The way to the two faders, which are the mixer's and not the panel's. A search result naming
   * one closes the panel and opens the mixer over the button it belongs to. */
  onOpenMixer?: () => void;
  /** A row to open on, named by its id: the same jump a search result makes, for the callers that
   * open the panel at one row rather than at the top. */
  jumpTo?: string | null;
}) {
  const [values, setValues] = useState<Settings | null>(null);
  const [tab, setTab] = useState<SettingsTab>('sound');
  const [query, setQuery] = useState('');
  /** The row a search result jumped to, held until the next jump or the next open. */
  const [marked, setMarked] = useState<string | null>(null);
  const [velocity, setVelocity] = useState<number | null>(null);
  const [pdmxReady, setPdmxReady] = useState<boolean | null>(null);
  // The panel stays mounted for its slide, so a shut panel must not re-render on every strike.
  const midi = useMidiStatus((event) => {
    if (open && event.on) setVelocity(event.velocity);
  });
  const pdmx = usePdmxDownload();
  const downloading = pdmx.progress !== null;

  // Read again at every open, so the panel is in step with the popovers and with a finished PDMX
  // download, which writes the folder itself while nothing is listening.
  useEffect(() => {
    if (open) readSettings().then(setValues, console.error);
    else setMarked(null);
  }, [open, downloading]);

  // The tab and the mark land in one render, as they do for a search result, so the scroll effect
  // below finds the row on the page.
  useEffect(() => {
    const row = jumpTo && SEARCH_ROWS.find((each) => each.id === jumpTo);
    if (!open || !row || row.tab === 'mixer') return;
    setTab(row.tab);
    setMarked(row.id);
  }, [open, jumpTo]);

  // Whether the folder in force holds unpacked scores. Rust answers off the disk, not the setting.
  useEffect(() => {
    const folder = values?.pdmx_folder;
    if (folder === undefined) return;
    let live = true;
    const hold = (ready: boolean) => {
      if (live) setPdmxReady(ready);
    };
    invoke<boolean>('pdmx_status', { folder }).then(hold, () => hold(false));
    return () => {
      live = false;
    };
  }, [values?.pdmx_folder]);

  // The tab switch and the mark land in one render, so the row is on the page by the time this
  // runs. A row on a tab nobody has built yet is not in `SEARCH_ROWS`, so there is nothing to miss.
  useEffect(() => {
    if (marked) document.getElementById(rowId(marked))?.scrollIntoView({ block: 'center' });
  }, [marked]);

  // A pinch writes the setting itself, so the panel only has to follow the value. The two halves
  // are the dependencies, so a pinch step moves the row and a render on its own does not.
  const [liveKey, liveValue] = live ?? [];
  useEffect(() => {
    if (liveKey) setValues((held) => held && { ...held, [liveKey]: liveValue });
  }, [liveKey, liveValue]);

  function write<K extends keyof Settings>(key: K, value: Settings[K]): void {
    setValues((held) => held && { ...held, [key]: value });
    setSetting(key, value).catch(console.error);
    if (key === 'midi_device') pinMidiDevice(value as string | null);
    // The theme paints the whole app, so it is applied here rather than by whatever is behind.
    if (key === 'theme') setTheme(value as Theme);
    // The pair comes straight out of this function's own key type, so it is one of the union.
    onGlobalChange?.(...([key, value] as SettingChange));
  }

  /** One line for the PDMX row: how far the download has got, or what is on disk. */
  const pdmxStatus = pdmx.progress
    ? progressLabel(pdmx.progress)
    : pdmxReady === null
      ? ''
      : pdmxReady
        ? 'Ready'
        : 'Not downloaded';

  async function chooseFolder(key: 'library_folder' | 'pdmx_folder'): Promise<void> {
    const picked = await openDialog({ directory: true, defaultPath: values?.[key] || undefined });
    if (typeof picked === 'string') write(key, picked);
  }

  const results = searchRows(query);

  return (
    // `role="dialog"` with a state is what the play screen's keys watch for: while the panel is
    // open, Space and Escape are the panel's and never reach the clock.
    <aside
      role="dialog"
      aria-label="Settings"
      data-state={open ? 'open' : 'closed'}
      inert={!open}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
      className={`bg-chrome border-edge-soft fixed inset-y-0 right-0 z-40 flex w-[380px] max-w-full flex-col border-l shadow-xl transition-transform duration-200 ease-[var(--ease)] motion-reduce:transition-none ${
        open ? 'translate-x-0' : 'translate-x-full'
      }`}
    >
      <div className="border-edge-soft flex h-12 flex-none items-center gap-2 border-b px-3">
        <h2 className="text-[13px] font-semibold">Settings</h2>
        <button
          onClick={onClose}
          aria-label="Close settings"
          className="hover:bg-ink/8 ml-auto flex size-8 flex-none items-center justify-center rounded-md transition-colors duration-150"
        >
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>

      <div className="relative flex-none px-3 pt-3">
        <Input
          type="search"
          value={query}
          aria-label="Search settings"
          placeholder="Search settings"
          onChange={(event) => setQuery(event.target.value)}
          className="h-8 text-[12px]"
        />
        {results.length > 0 && (
          <ul className="bg-chrome border-edge-soft absolute inset-x-3 top-full z-10 mt-1 max-h-64 overflow-y-auto border shadow-md">
            {results.map((row) => (
              <li key={row.id}>
                <button
                  onClick={() => {
                    setQuery('');
                    // A fader is not a row here, so the result hands the player to the mixer
                    // rather than to a tab that does not hold it.
                    if (row.tab === 'mixer') {
                      onClose();
                      onOpenMixer?.();
                      return;
                    }
                    setTab(row.tab);
                    setMarked(row.id);
                  }}
                  className="hover:bg-ink/8 flex w-full items-baseline gap-3 px-2.5 py-1.5 text-left text-[12px]"
                >
                  <span className="min-w-0 truncate">{row.label}</span>
                  <span className="text-muted-ink ml-auto flex-none text-[11px]">
                    {row.group ? `${WHERE_LABELS[row.tab]} · ${row.group}` : WHERE_LABELS[row.tab]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Tabs.Root
        value={tab}
        onValueChange={(next) => {
          setTab(next as SettingsTab);
          setMarked(null);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.List className="border-edge-soft flex flex-none gap-0.5 border-b px-3 pt-3">
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
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-3 py-4">
          {values && (
            <>
              <Tabs.Content value="sound" className="flex flex-col gap-7">
                {/* The sound engine's own settings write straight to it, not through `write`:
                    each one has to reach the running engine as well as the database. The two
                    volumes are not here at all; they are the mixer's two faders. */}
                <SoundTab marked={marked} velocity={velocity} />
              </Tabs.Content>

              <Tabs.Content value="look" className="flex flex-col gap-6">
                <Rows>
                  <Row id="theme" marked={marked === 'theme'} label="Theme">
                    <Segmented
                      options={THEMES}
                      value={values.theme}
                      onChange={(value) => write('theme', value)}
                    />
                  </Row>
                </Rows>

                {/* Sheet and falling notes each carry their own harmony and their own colours, so
                    each heading names the view its rows move and nothing else. */}
                <section className="flex flex-col gap-1.5">
                  <h3 className="text-muted-ink text-[11px] tracking-wide uppercase">Sheet</h3>
                  <Rows>
                    <Row
                      id="sheet_proportional"
                      marked={marked === 'sheet_proportional'}
                      label="Space notes by time"
                    >
                      <Toggle
                        value={values.sheet_proportional}
                        onChange={(value) => write('sheet_proportional', value)}
                      />
                    </Row>
                    <Row id="sheet_spacing" marked={marked === 'sheet_spacing'} label="Spacing">
                      <Slider
                        label="Sheet spacing in percent"
                        value={values.sheet_spacing}
                        min={SPACING_MIN}
                        max={SPACING_MAX}
                        step={5}
                        disabled={!values.sheet_proportional}
                        onChange={(value) => write('sheet_spacing', value)}
                      />
                    </Row>
                    <Row id="sheet_harmony" marked={marked === 'sheet_harmony'} label="Harmony">
                      <Toggle
                        value={values.sheet_harmony}
                        onChange={(value) => write('sheet_harmony', value)}
                      />
                    </Row>
                    <Row
                      id="sheet_colour"
                      marked={marked === 'sheet_colour'}
                      label="Pitch colours"
                    >
                      <Toggle
                        value={values.sheet_colour}
                        onChange={(value) => write('sheet_colour', value)}
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
                      marked={marked === 'lane_lookahead'}
                      label="Lookahead (beats)"
                    >
                      <Slider
                        label="Lane lookahead in beats"
                        value={values.lane_lookahead}
                        min={LOOKAHEAD_MIN}
                        max={LOOKAHEAD_MAX}
                        step={0.1}
                        onChange={(value) => write('lane_lookahead', value)}
                      />
                    </Row>
                    <Row
                      id="lane_note_width"
                      marked={marked === 'lane_note_width'}
                      label="Note width (%)"
                    >
                      <NumberField
                        value={values.lane_note_width}
                        min={10}
                        max={100}
                        onChange={(value) => write('lane_note_width', value)}
                      />
                    </Row>
                    <Row id="lane_gap" marked={marked === 'lane_gap'} label="Gap (px)">
                      <NumberField
                        value={values.lane_gap}
                        min={0}
                        max={20}
                        onChange={(value) => write('lane_gap', value)}
                      />
                    </Row>
                    <Row
                      id="lane_names"
                      marked={marked === 'lane_names'}
                      label="Note names on blocks"
                    >
                      <Toggle
                        value={values.lane_names}
                        onChange={(value) => write('lane_names', value)}
                      />
                    </Row>
                    <Row id="lane_harmony" marked={marked === 'lane_harmony'} label="Harmony">
                      <Toggle
                        value={values.lane_harmony}
                        onChange={(value) => write('lane_harmony', value)}
                      />
                    </Row>
                    <Row id="lane_colour" marked={marked === 'lane_colour'} label="Pitch colours">
                      <Toggle
                        value={values.lane_colour}
                        onChange={(value) => write('lane_colour', value)}
                      />
                    </Row>
                    <Row
                      id="keyboard_labels"
                      marked={marked === 'keyboard_labels'}
                      label="Note names on keys"
                    >
                      <Toggle
                        value={values.keyboard_labels}
                        onChange={(value) => write('keyboard_labels', value)}
                      />
                    </Row>
                  </Rows>
                </section>

                {/* Keyboard size lays the keys out under the falling notes and changes nothing on
                    the sheet, so it sits outside that heading rather than under it. */}
                <Rows>
                  <Row id="keyboard_size" marked={marked === 'keyboard_size'} label="Keyboard size">
                    <Segmented
                      options={PRESETS}
                      value={values.keyboard_preset}
                      onChange={(value) => write('keyboard_preset', value)}
                    />
                  </Row>
                  {values.keyboard_preset === 'custom' && (
                    <Row label="Custom range">
                      <CustomRange
                        lo={values.keyboard_lo}
                        hi={values.keyboard_hi}
                        onChange={(lo, hi) => {
                          write('keyboard_lo', lo);
                          write('keyboard_hi', hi);
                        }}
                      />
                    </Row>
                  )}
                </Rows>
              </Tabs.Content>

              <Tabs.Content value="playing" className="flex flex-col gap-7">
                <Rows>
                  <Row id="midi_device" marked={marked === 'midi_device'} label="Input device">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label="MIDI input device"
                          className="h-7 max-w-[190px] justify-between px-2 text-[12px] font-normal"
                        >
                          <span className="truncate">
                            {midi.ports.find((port) => port.id === values.midi_device)?.name ??
                              'Any device'}
                          </span>
                          <ChevronDown className="size-3.5 opacity-60" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="max-w-[260px]">
                        <DropdownMenuRadioGroup
                          value={values.midi_device ?? ''}
                          onValueChange={(id) => write('midi_device', id || null)}
                        >
                          <DropdownMenuRadioItem value="" className="text-[13px]">
                            Any device
                          </DropdownMenuRadioItem>
                          {midi.ports.map((port) => (
                            <DropdownMenuRadioItem
                              key={port.id}
                              value={port.id}
                              className="text-[13px]"
                            >
                              <span className="truncate">{port.name}</span>
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </Row>
                  <Row
                    id="velocity_offset"
                    marked={marked === 'velocity_offset'}
                    label="Velocity offset"
                  >
                    <div className="flex items-center gap-3">
                      <NumberField
                        value={values.velocity_offset}
                        min={-64}
                        max={64}
                        onChange={(value) => write('velocity_offset', value)}
                      />
                      <span className="text-muted-ink text-[12px] tabular-nums">
                        last strike {velocity ?? '—'}
                      </span>
                    </div>
                  </Row>
                  <Row
                    id="matching_window_ms"
                    marked={marked === 'matching_window_ms'}
                    label="Matching window (ms)"
                  >
                    <NumberField
                      value={values.matching_window_ms}
                      min={1}
                      max={1000}
                      onChange={(value) => write('matching_window_ms', value)}
                    />
                  </Row>
                  <Row
                    id="togetherness_ms"
                    marked={marked === 'togetherness_ms'}
                    label="Togetherness window (ms)"
                  >
                    <NumberField
                      value={values.togetherness_ms}
                      min={1}
                      max={1000}
                      onChange={(value) => write('togetherness_ms', value)}
                    />
                  </Row>
                </Rows>

                {import.meta.env.DEV && (
                  <details id={rowId('grade_tuning')} open={marked === 'grade_tuning'}>
                    <summary className="cursor-pointer text-[13px] font-semibold">
                      Grade tuning
                    </summary>
                    <p className="text-muted-ink mt-1 text-[11.5px]">
                      Grade normalises the three weights whatever they hold.
                    </p>
                    <div className="mt-3">
                      <Rows>
                        {GRADE_KNOBS.map(([key, label, min, max]) => (
                          <Row key={key} label={label}>
                            <NumberField
                              value={values[key] as number}
                              min={min}
                              max={max}
                              onChange={(value) => write(key, value as never)}
                            />
                          </Row>
                        ))}
                      </Rows>
                    </div>
                  </details>
                )}
              </Tabs.Content>

              <Tabs.Content value="library" className="flex flex-col gap-2">
                <p className="text-muted-ink text-[11.5px]">
                  A new library folder re-points the app. No file is moved.
                </p>
                <Rows>
                  <Row id="library_folder" marked={marked === 'library_folder'} label="Library folder">
                    <Path
                      value={values.library_folder}
                      onChoose={() => chooseFolder('library_folder').catch(console.error)}
                    />
                  </Row>
                  <Row id="pdmx_folder" marked={marked === 'pdmx_folder'} label="PDMX folder">
                    <Path
                      value={values.pdmx_folder}
                      onChoose={() => chooseFolder('pdmx_folder').catch(console.error)}
                    />
                  </Row>
                  <Row id="pdmx_scores" marked={marked === 'pdmx_scores'} label="PDMX scores">
                    <span className="flex flex-none flex-col items-end gap-0.5">
                      <span className="flex items-center gap-3">
                        <span className="text-muted-ink text-[12px] tabular-nums">{pdmxStatus}</span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 flex-none"
                          onClick={() => {
                            if (downloading) cancelPdmx();
                            else void downloadPdmx();
                          }}
                        >
                          {downloading ? 'Cancel' : 'Download (1.9 GB)'}
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
    </aside>
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
        left: clamp(held.x + PINCH_GAP, PINCH_GAP, window.innerWidth - PINCH_W - PINCH_GAP),
        top: clamp(held.y + PINCH_GAP, PINCH_GAP, window.innerHeight - PINCH_H - PINCH_GAP),
        width: PINCH_W,
      }}
      className={`bg-chrome border-edge-soft pointer-events-none fixed z-50 flex items-center gap-2 rounded-md border px-3 py-2 text-[12px] shadow-md transition-opacity duration-150 ease-[var(--ease)] ${shown ? 'opacity-100' : 'opacity-0'}`}
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
      <span className="w-10 flex-none text-right tabular-nums">{held.spacing} %</span>
    </div>
  );
}

/** The divided list the panel's rows sit in. */
function Rows({ children }: { children: React.ReactNode }) {
  return <div className="divide-edge-soft border-edge-soft divide-y border-y">{children}</div>;
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
      className={`flex min-h-8 items-center justify-between gap-3 py-1 text-[12px] ${marked ? 'bg-ink/8' : ''}`}
    >
      <span className={hint ? 'flex flex-col gap-0.5' : 'flex-none'}>
        {label}
        {hint && <span className="text-muted-ink text-[11px] leading-snug">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

function Path({ value, onChoose }: { value: string; onChoose: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="text-muted-ink truncate text-[11.5px] select-text">{value || 'not set'}</code>
      <Button variant="outline" size="sm" className="h-7 flex-none" onClick={onChoose}>
        Choose…
      </Button>
    </div>
  );
}

/**
 * A number that writes as it is typed. Text that is no number of the span leaves the setting at its
 * last valid value and says so under the field.
 */
function NumberField({
  value,
  min,
  max,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  /** What this field last wrote, so a value that moved elsewhere is told apart from typing. */
  const written = useRef(value);

  // A pinch behind the panel moves the value without the field being touched.
  useEffect(() => {
    if (value === written.current) return;
    written.current = value;
    setText(String(value));
    setError(null);
  }, [value]);

  return (
    <span className="flex flex-none flex-col items-end gap-0.5">
      <Input
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          const checked = validNumber(event.target.value, min, max, value);
          setError(checked.error);
          if (checked.error) return;
          written.current = checked.value;
          onChange(checked.value);
        }}
        className="h-7 w-20 px-2 text-right text-[12px] tabular-nums"
      />
      {error && <span className="text-[11px] text-red-600 dark:text-red-400">{error}</span>}
    </span>
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
      <span className="text-muted-ink w-8 text-right text-[11px] tabular-nums">{value}</span>
    </span>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (value: boolean) => void }) {
  return (
    <Segmented
      options={[
        [true, 'On'],
        [false, 'Off'],
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
            value === each ? 'bg-ink text-paper' : 'hover:bg-ink/8'
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
  const [detecting, setDetecting] = useState<{ first: number | null } | null>(null);

  useMidiStatus((event) => {
    if (!detecting || !event.on) return;
    if (detecting.first === null) return setDetecting({ first: event.midi });
    setDetecting(null);
    onChange(Math.min(detecting.first, event.midi), Math.max(detecting.first, event.midi));
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
            ? 'Strike the lowest and the highest key…'
            : 'Now the other end…'
          : 'Detect from keyboard'}
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
