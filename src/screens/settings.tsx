// The two settings surfaces: the global dialog, opened from the library gear and from the play
// screen's gear popover, and the gear popover itself, which edits the open piece. Every control
// writes on change; there is no Save.

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  LANE_KNOBS,
  PIECE_DEFAULT_KEYS,
  readSettings,
  setSetting,
  SETTING_DEFAULTS,
  type Settings,
} from '@/db/db';
import type { LaneLook } from '@/lane/lane';
import { cancelPdmx, downloadPdmx, progressLabel, usePdmxDownload } from '@/library/pdmx';
import { noteName } from '@/look/color';
import { setTheme, useTheme, type Theme } from '@/look/use-dark';
import { pinMidiDevice, useMidiStatus } from '@/midi/use-midi-status';
import { validNumber, type PieceSettings } from '@/play/resolve';
import { TEMPO_RANGE, type HandsSetting, type KeyboardPreset } from '@/play/settings';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useRef, useState } from 'react';

/** The whole keyboard, the span both note dropdowns offer. */
const NOTES = Array.from({ length: 88 }, (_, at) => 21 + at);

const THEMES: [Theme, string][] = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
];

const HANDS: [HandsSetting, string][] = [
  ['both', 'Both'],
  ['left', 'Left'],
  ['right', 'Right'],
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

/** The lane's numbers, drawn by the dialog and by the gear popover from the one span each. */
const LANE_FIELDS: [key: keyof typeof LANE_KNOBS, label: string, min: number, max: number][] = [
  ['lane_lookahead', 'Lookahead (beats)', 1, 32],
  ['lane_note_width', 'Note width (%)', 10, 100],
  ['lane_gap', 'Gap (px)', 0, 20],
];

/** Every Grade knob in one place: the group is uniform, so it is drawn from a list. */
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
  ['matching_window_ms', 'Matching window (ms)', 1, 1000],
  ['togetherness_ms', 'Togetherness window (ms)', 1, 1000],
];

/** One global setting as it was just written: a key, with a value of that key's own type. */
export type SettingChange = { [K in keyof Settings]: [key: K, value: Settings[K]] }[keyof Settings];

/**
 * Every global setting, in the five groups. A knob the running play reads is handed to
 * `onGlobalChange` as it is written, so a change mid-practice applies at once.
 */
export function SettingsDialog({
  onClose,
  onGlobalChange,
}: {
  onClose: () => void;
  onGlobalChange?: (...change: SettingChange) => void;
}) {
  const [values, setValues] = useState<Settings | null>(null);
  const [velocity, setVelocity] = useState<number | null>(null);
  const [pdmxReady, setPdmxReady] = useState<boolean | null>(null);
  const midi = useMidiStatus((event) => {
    if (event.on) setVelocity(event.velocity);
  });
  const theme = useTheme();
  const pdmx = usePdmxDownload();
  const downloading = pdmx.progress !== null;

  // A finished PDMX download writes the folder itself, so the settings are read again when one
  // stops: the dialog is not always open to hear about it.
  useEffect(() => {
    readSettings().then(setValues, console.error);
  }, [downloading]);

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

  function write<K extends keyof Settings>(key: K, value: Settings[K]): void {
    setValues((held) => held && { ...held, [key]: value });
    setSetting(key, value).catch(console.error);
    if (key === 'theme') setTheme(value as Theme);
    if (key === 'midi_device') pinMidiDevice(value as string | null);
    // The pair comes straight out of this function's own key type, so it is one of the union.
    onGlobalChange?.(...([key, value] as SettingChange));
  }

  function reset(keys: (keyof Settings)[]): void {
    for (const key of keys) write(key, SETTING_DEFAULTS[key] as never);
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
    const picked = await open({ directory: true, defaultPath: values?.[key] || undefined });
    if (typeof picked === 'string') write(key, picked);
  }

  // The box is centred on itself, so it must mount at its full size: content that arrived later
  // would grow the box and re-centre it under the open animation.
  if (!values) return null;

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Settings</DialogTitle>
          <DialogDescription className="sr-only">Every setting of the app.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-7">
          {/* The library folder is the library, and an empty one has no undo, so Reset leaves it. */}
          <Group
            title="Library"
            onReset={() => reset(['pdmx_folder'])}
            note="A new library folder re-points the app. No file is moved."
          >
            <Row label="Library folder">
              <Path
                value={values.library_folder}
                onChoose={() => chooseFolder('library_folder').catch(console.error)}
              />
            </Row>
            <Row label="PDMX folder">
              <Path
                value={values.pdmx_folder}
                onChoose={() => chooseFolder('pdmx_folder').catch(console.error)}
              />
            </Row>
            <Row label="PDMX scores">
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
                    {downloading ? 'Cancel' : 'Download PDMX (1.9 GB)'}
                  </Button>
                </span>
                {pdmx.error && (
                  <span className="text-[11px] text-red-600 dark:text-red-400">{pdmx.error}</span>
                )}
              </span>
            </Row>
          </Group>

          <Group
            title="Playing defaults"
            note="A piece that holds a setting of its own keeps it."
            onReset={() => reset(Object.keys(PIECE_DEFAULT_KEYS) as (keyof Settings)[])}
          >
            <Row label="Tempo (%)">
              <NumberField
                value={values.default_tempo_value}
                min={TEMPO_RANGE.percent[0]}
                max={TEMPO_RANGE.percent[1]}
                onChange={(value) => write('default_tempo_value', value)}
              />
            </Row>
            <Row label="Metronome">
              <Toggle
                value={values.default_metronome}
                onChange={(value) => write('default_metronome', value)}
              />
            </Row>
            <Row label="Count-in bars">
              <NumberField
                value={values.default_count_in_bars}
                min={0}
                max={8}
                onChange={(value) => write('default_count_in_bars', value)}
              />
            </Row>
            <Row label="Hands">
              <Segmented
                options={HANDS}
                value={values.default_hands}
                onChange={(value) => write('default_hands', value)}
              />
            </Row>
            <Row label="Keyboard">
              <Segmented
                options={PRESETS}
                value={values.default_keyboard_preset}
                onChange={(value) => write('default_keyboard_preset', value)}
              />
            </Row>
            {values.default_keyboard_preset === 'custom' && (
              <Row label="Custom range">
                <CustomRange
                  lo={values.default_keyboard_lo}
                  hi={values.default_keyboard_hi}
                  onChange={(lo, hi) => {
                    write('default_keyboard_lo', lo);
                    write('default_keyboard_hi', hi);
                  }}
                />
              </Row>
            )}
          </Group>

          <Group
            title="Play screen"
            onReset={() =>
              reset([
                ...LANE_FIELDS.map(([key]) => key),
                'sheet_split',
                'keyboard_labels',
                'click_volume',
                'theme',
              ])
            }
          >
            {LANE_FIELDS.map(([key, label, min, max]) => (
              <Row key={key} label={label}>
                <NumberField
                  value={values[key] as number}
                  min={min}
                  max={max}
                  onChange={(value) => write(key, value as never)}
                />
              </Row>
            ))}
            <Row label="Sheet split">
              <NumberField
                value={values.sheet_split}
                min={0.2}
                max={0.6}
                onChange={(value) => write('sheet_split', value)}
              />
            </Row>
            <Row label="Note names on keys">
              <Toggle
                value={values.keyboard_labels}
                onChange={(value) => write('keyboard_labels', value)}
              />
            </Row>
            <Row label="Click volume">
              <NumberField
                value={values.click_volume}
                min={0}
                max={100}
                onChange={(value) => write('click_volume', value)}
              />
            </Row>
            <Row label="Theme">
              <Segmented
                options={THEMES}
                value={theme}
                onChange={(value) => write('theme', value)}
              />
            </Row>
          </Group>

          <Group title="MIDI" onReset={() => reset(['midi_device', 'velocity_offset'])}>
            <Row label="Input device">
              <select
                aria-label="MIDI input device"
                value={values.midi_device ?? ''}
                onChange={(event) => write('midi_device', event.target.value || null)}
                className="border-edge h-7 border bg-transparent px-2 text-[12px]"
              >
                <option value="">Any device</option>
                {midi.ports.map((port) => (
                  <option key={port.id} value={port.id}>
                    {port.name}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Velocity offset">
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
          </Group>

          <details className="flex flex-col gap-2">
            <summary className="cursor-pointer text-[13px] font-semibold select-none">
              Grade tuning
            </summary>
            <div className="mt-3">
              <Group
                title=""
                note="Grade normalises the three weights whatever they hold."
                onReset={() => reset(GRADE_KNOBS.map(([key]) => key))}
              >
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
              </Group>
            </div>
          </details>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The gear under the play screen's bar: the look of the app and of the lane, the keyboard range of
 * the open piece, and the way out to every other setting.
 */
export function GearPopover({
  trigger,
  performing,
  keyboard,
  countInBars,
  look,
  onKeyboard,
  onCountInBars,
  onLook,
  onUseGlobalDefaults,
  onAllSettings,
}: {
  trigger: React.ReactNode;
  /** A performance writes no setting, so everything that would write is off. */
  performing: boolean;
  keyboard: Pick<PieceSettings, 'keyboardPreset' | 'keyboardLo' | 'keyboardHi'>;
  countInBars: number;
  look: LaneLook;
  onKeyboard: (preset: KeyboardPreset, lo: number, hi: number) => void;
  onCountInBars: (bars: number) => void;
  onLook: (key: keyof typeof LANE_KNOBS, value: number | boolean) => void;
  onUseGlobalDefaults: () => void;
  onAllSettings: () => void;
}) {
  const theme = useTheme();

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="flex w-72 flex-col gap-4 p-3">
        <PopoverGroup title="Look">
          <Row label="Theme">
            <Segmented
              options={THEMES}
              value={theme}
              onChange={(value) => {
                setTheme(value);
                setSetting('theme', value).catch(console.error);
              }}
            />
          </Row>
        </PopoverGroup>

        {!performing && (
          <PopoverGroup title="Keyboard">
            <Segmented
              options={PRESETS}
              value={keyboard.keyboardPreset}
              onChange={(preset) => onKeyboard(preset, keyboard.keyboardLo, keyboard.keyboardHi)}
            />
            {keyboard.keyboardPreset === 'custom' && (
              <CustomRange
                lo={keyboard.keyboardLo}
                hi={keyboard.keyboardHi}
                onChange={(lo, hi) => onKeyboard('custom', lo, hi)}
              />
            )}
          </PopoverGroup>
        )}

        {!performing && (
          <PopoverGroup title="Playing">
            <Row label="Count-in bars">
              <NumberField value={countInBars} min={0} max={8} onChange={onCountInBars} />
            </Row>
          </PopoverGroup>
        )}

        <PopoverGroup title="Falling notes">
          {LANE_FIELDS.map(([key, label, min, max]) => (
            <Row key={key} label={label}>
              <NumberField
                value={look[LANE_KNOBS[key]] as number}
                min={min}
                max={max}
                onChange={(value) => onLook(key, value)}
              />
            </Row>
          ))}
          <Row label="Note names on keys">
            <Toggle value={look.keyLabels} onChange={(value) => onLook('keyboard_labels', value)} />
          </Row>
        </PopoverGroup>

        {!performing && (
          <div className="border-edge-soft flex flex-col items-start gap-1.5 border-t pt-3">
            <button
              onClick={onUseGlobalDefaults}
              className="hover:text-ink text-muted-ink text-[12px] underline underline-offset-2"
            >
              Use global defaults
            </button>
            <button
              onClick={onAllSettings}
              className="hover:text-ink text-muted-ink text-[12px] underline underline-offset-2"
            >
              All settings…
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Group({
  title,
  note,
  onReset,
  children,
}: {
  title: string;
  note?: string;
  onReset: () => void;
  children: React.ReactNode;
}) {
  // A reset to a default equal to the value in force changes no prop, so the fields are rebuilt
  // by their key: text a field refused, and the message under it, start over from the setting.
  const [round, setRound] = useState(0);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        {title && <h3 className="text-[13px] font-semibold">{title}</h3>}
        {note && <p className="text-muted-ink text-[11.5px]">{note}</p>}
        <button
          onClick={() => {
            onReset();
            setRound((n) => n + 1);
          }}
          className="text-muted-ink hover:text-ink ml-auto text-[11.5px] underline underline-offset-2"
        >
          Reset group
        </button>
      </div>
      <div key={round} className="divide-edge-soft border-edge-soft divide-y border-y">
        {children}
      </div>
    </section>
  );
}

/** A group inside the gear popover, which is too narrow for the dialog's group furniture. */
function PopoverGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-muted-ink text-[11px] tracking-wide uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 py-1 text-[12px]">
      <span>{label}</span>
      {children}
    </div>
  );
}

function Path({ value, onChoose }: { value: string; onChoose: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="text-muted-ink truncate text-[11.5px]">{value || 'not set'}</code>
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

  // "Reset group" and "Use global defaults" both move the value without the field being touched.
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
