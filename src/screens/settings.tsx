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
import { getSettingOr, setSetting, SETTING_DEFAULTS, type Settings } from '@/db/db';
import { detectedRange } from '@/lane/keyboard';
import type { LaneLook } from '@/lane/lane';
import { noteName } from '@/look/color';
import { setTheme, useTheme, type Theme } from '@/look/use-dark';
import { pinMidiDevice, useMidiStatus } from '@/midi/useMidiStatus';
import { validNumber, type PieceSettings } from '@/play/resolve';
import type { HandsSetting, KeyboardPreset } from '@/play/settings';
import { open } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';

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

/**
 * Every global setting, in the five groups. A knob the running play reads is handed to
 * `onGlobalChange` as it is written, so a change mid-practice applies at once.
 */
export function SettingsDialog({
  onClose,
  onGlobalChange,
}: {
  onClose: () => void;
  onGlobalChange?: (key: keyof Settings, value: unknown) => void;
}) {
  const [values, setValues] = useState<Settings | null>(null);
  const [velocity, setVelocity] = useState<number | null>(null);
  const midi = useMidiStatus((event) => {
    if (event.on) setVelocity(event.velocity);
  });
  const theme = useTheme();

  useEffect(() => {
    void readSettings().then(setValues);
  }, []);

  function write<K extends keyof Settings>(key: K, value: Settings[K]): void {
    setValues((held) => held && { ...held, [key]: value });
    void setSetting(key, value);
    if (key === 'theme') setTheme(value as Theme);
    if (key === 'midi_device') pinMidiDevice(value as string | null);
    onGlobalChange?.(key, value);
  }

  function reset(keys: (keyof Settings)[]): void {
    for (const key of keys) write(key, SETTING_DEFAULTS[key] as never);
  }

  async function chooseFolder(key: 'library_folder' | 'pdmx_folder'): Promise<void> {
    const picked = await open({ directory: true, defaultPath: values?.[key] || undefined });
    if (typeof picked === 'string') write(key, picked);
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Settings</DialogTitle>
          <DialogDescription className="sr-only">Every setting of the app.</DialogDescription>
        </DialogHeader>

        {values && (
          <div className="flex flex-col gap-7">
            <Group
              title="Library"
              onReset={() => reset(['pdmx_folder'])}
              note="A new library folder re-points the app. No file is moved."
            >
              <Row label="Library folder">
                <Path value={values.library_folder} onChoose={() => void chooseFolder('library_folder')} />
              </Row>
              <Row label="PDMX folder">
                <Path value={values.pdmx_folder} onChoose={() => void chooseFolder('pdmx_folder')} />
              </Row>
            </Group>

            <Group
              title="Playing defaults"
              note="A piece that holds a setting of its own keeps it."
              onReset={() =>
                reset([
                  'default_tempo_value',
                  'default_metronome',
                  'default_count_in_bars',
                  'default_hands',
                  'default_keyboard_preset',
                  'default_keyboard_lo',
                  'default_keyboard_hi',
                ])
              }
            >
              <Row label="Tempo (%)">
                <NumberField
                  value={values.default_tempo_value}
                  min={25}
                  max={200}
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
                  <NoteRange
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
                  'lane_lookahead',
                  'lane_note_width',
                  'lane_gap',
                  'sheet_split',
                  'keyboard_labels',
                  'click_volume',
                  'theme',
                ])
              }
            >
              <Row label="Lookahead (beats)">
                <NumberField
                  value={values.lane_lookahead}
                  min={1}
                  max={32}
                  onChange={(value) => write('lane_lookahead', value)}
                />
              </Row>
              <Row label="Note width (%)">
                <NumberField
                  value={values.lane_note_width}
                  min={10}
                  max={100}
                  onChange={(value) => write('lane_note_width', value)}
                />
              </Row>
              <Row label="Gap (px)">
                <NumberField
                  value={values.lane_gap}
                  min={0}
                  max={20}
                  onChange={(value) => write('lane_gap', value)}
                />
              </Row>
              <Row label="Sheet split">
                <NumberField
                  value={values.sheet_split}
                  min={0.2}
                  max={0.6}
                  step={0.05}
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
                        step={max <= 10 ? 0.05 : 1}
                        onChange={(value) => write(key, value as never)}
                      />
                    </Row>
                  ))}
                </Group>
              </div>
            </details>
          </div>
        )}
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
  onLook: (look: Partial<LaneLook>) => void;
  onUseGlobalDefaults: () => void;
  onAllSettings: () => void;
}) {
  const theme = useTheme();
  /** The first of the two strikes "Detect from keyboard" is waiting for, if it has come. */
  const [detecting, setDetecting] = useState<{ first: number | null } | null>(null);

  useMidiStatus((event) => {
    if (!detecting || !event.on) return;
    if (detecting.first === null) return setDetecting({ first: event.midi });
    const [lo, hi] = detectedRange(detecting.first, event.midi);
    setDetecting(null);
    onKeyboard('custom', lo, hi);
  });

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="flex w-72 flex-col gap-4 p-3">
        <Section title="Look">
          <Row label="Theme">
            <Segmented
              options={THEMES}
              value={theme}
              onChange={(value) => {
                setTheme(value);
                void setSetting('theme', value);
              }}
            />
          </Row>
        </Section>

        {!performing && (
          <Section title="Keyboard">
            <Segmented
              options={PRESETS}
              value={keyboard.keyboardPreset}
              onChange={(preset) => onKeyboard(preset, keyboard.keyboardLo, keyboard.keyboardHi)}
            />
            {keyboard.keyboardPreset === 'custom' && (
              <>
                <NoteRange
                  lo={keyboard.keyboardLo}
                  hi={keyboard.keyboardHi}
                  onChange={(lo, hi) => onKeyboard('custom', lo, hi)}
                />
                <button
                  onClick={() => setDetecting({ first: null })}
                  className="text-muted-ink hover:text-ink self-start text-[12px] underline underline-offset-2"
                >
                  {detecting
                    ? detecting.first === null
                      ? 'Strike the lowest and the highest key…'
                      : 'Now the other end…'
                    : 'Detect from keyboard'}
                </button>
              </>
            )}
          </Section>
        )}

        {!performing && (
          <Section title="Playing">
            <Row label="Count-in bars">
              <NumberField value={countInBars} min={0} max={8} onChange={onCountInBars} />
            </Row>
          </Section>
        )}

        <Section title="Falling notes">
          <Row label="Lookahead (beats)">
            <NumberField
              value={look.lookaheadBeats}
              min={1}
              max={32}
              onChange={(value) => onLook({ lookaheadBeats: value })}
            />
          </Row>
          <Row label="Note width (%)">
            <NumberField
              value={look.noteWidthPct}
              min={10}
              max={100}
              onChange={(value) => onLook({ noteWidthPct: value })}
            />
          </Row>
          <Row label="Gap (px)">
            <NumberField value={look.gapPx} min={0} max={20} onChange={(value) => onLook({ gapPx: value })} />
          </Row>
          <Row label="Note names on keys">
            <Toggle value={look.keyLabels} onChange={(value) => onLook({ keyLabels: value })} />
          </Row>
        </Section>

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

/** Every setting, read once with its default for the one never written. */
async function readSettings(): Promise<Settings> {
  const keys = Object.keys(SETTING_DEFAULTS) as (keyof Settings)[];
  const values = await Promise.all(keys.map((key) => getSettingOr(key, SETTING_DEFAULTS[key])));
  return Object.fromEntries(keys.map((key, at) => [key, values[at]])) as Settings;
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
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        {title && <h3 className="text-[13px] font-semibold">{title}</h3>}
        {note && <p className="text-muted-ink text-[11.5px]">{note}</p>}
        <button
          onClick={onReset}
          className="text-muted-ink hover:text-ink ml-auto text-[11.5px] underline underline-offset-2"
        >
          Reset group
        </button>
      </div>
      <div className="divide-edge-soft border-edge-soft divide-y border-y">{children}</div>
    </section>
  );
}

/** A heading inside the gear popover, which is too narrow for the dialog's group furniture. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
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
  step = 1,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [error, setError] = useState<string | null>(null);

  // The value can move without the field: "Reset group" and "Use global defaults" both write it.
  useEffect(() => {
    setText(String(value));
    setError(null);
  }, [value]);

  return (
    <span className="flex flex-none flex-col items-end gap-0.5">
      <Input
        type="text"
        inputMode="decimal"
        value={text}
        step={step}
        onChange={(event) => {
          setText(event.target.value);
          const checked = validNumber(event.target.value, min, max, value);
          setError(checked.error);
          if (!checked.error) onChange(checked.value);
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

/** The two ends of a custom keyboard range. The low end never passes the high one. */
function NoteRange({
  lo,
  hi,
  onChange,
}: {
  lo: number;
  hi: number;
  onChange: (lo: number, hi: number) => void;
}) {
  return (
    <div className="flex flex-none items-center gap-1.5">
      <NoteSelect label="Lowest key" value={lo} onChange={(next) => onChange(next, Math.max(next, hi))} />
      <span className="text-muted-ink text-[12px]">to</span>
      <NoteSelect label="Highest key" value={hi} onChange={(next) => onChange(Math.min(lo, next), next)} />
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
