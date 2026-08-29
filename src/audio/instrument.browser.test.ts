import { InstrumentSection, restoreInstrument } from '@/audio/instrument';
import type { Settings } from '@/db/db';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const CONCERT = {
  id: 'file:/Music/Concert Grand Piano.exs',
  name: 'Concert Grand Piano',
  kind: 'file',
  loaded: true,
  reason: '',
};
const BROKEN = {
  id: 'file:/instruments/broken.sf2',
  name: 'broken.sf2',
  kind: 'file',
  loaded: false,
  reason: '',
};
const HOSTED = {
  id: 'plugin:Vintage Electric Piano',
  name: 'Vintage Electric Piano',
  kind: 'plugin',
  loaded: true,
  reason: '',
};

/** What the engine answers about itself, of which this section reads the rates. */
let status: Record<string, unknown> = { instrument: '', instrument_rate: 0 };
/** The rate setting in force, which an instrument recorded lower than it drags down. */
let rateSetting = 44100;

let listed = [HOSTED, CONCERT, BROKEN];
let refusal: string | null = null;
let loads: unknown[] = [];
/** Set by a test that wants the load to stand still until it releases it. */
let held: { promise: Promise<void>; release: () => void } | null = null;

/** A load that hangs where the engine would be working, and the way to let it finish. */
function hold(): { promise: Promise<void>; release: () => void } {
  let release = (): void => {};
  const promise = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  return { promise, release };
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === 'audio_instruments') return listed;
    if (command === 'audio_status') return status;
    if (command === 'audio_set_sample_rate') return null;
    if (command === 'audio_load_instrument') {
      loads.push(args);
      if (held) await held.promise;
      if (refusal) throw new Error(refusal);
      return null;
    }
    throw new Error(`unexpected command ${command}`);
  },
}));

let written: [string, unknown][] = [];

vi.mock('@/db/db', () => ({
  readSettings: async () => ({ instruments_folder: '/instruments', instrument_id: null }),
  setSetting: async (key: string, value: unknown) => {
    written.push([key, value]);
  },
  // No instrument here has been given an envelope, so restoring one after a load does nothing.
  getSettingOr: async (key: string) => (key === 'audio_sample_rate' ? rateSetting : {}),
}));

let close: (() => void) | null = null;

beforeEach(() => {
  listed = [HOSTED, CONCERT, BROKEN];
  status = { instrument: '', instrument_rate: 0 };
  rateSetting = 44100;
  refusal = null;
  held = null;
  loads = [];
  written = [];
});

afterEach(() => {
  close?.();
  close = null;
});

/** Mounts the section and hands back the text the user can read and the section's host. */
async function open(): Promise<[() => string, HTMLElement]> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(InstrumentSection, {}));
  close = () => {
    root.unmount();
    host.remove();
  };
  // The rows are a portal beside the section, so what the user can read is the whole page.
  const text = (): string => document.body.textContent ?? '';
  await vi.waitFor(() => expect(trigger().textContent).toContain('None'));
  return [text, host];
}

/** The picker itself, which names the instrument in force and beats while one is loading. */
function trigger(): HTMLElement {
  return document.querySelector<HTMLElement>('[aria-label="Instrument"]')!;
}

function openPicker(): void {
  trigger().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
}

/** The rows the open picker offers, each one instrument, in the order it lists them. */
function rows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
}

/** Opens the picker and clicks the instrument by the name it reads. */
async function pick(name: string): Promise<void> {
  openPicker();
  await vi.waitFor(() => expect(rows().length).toBeGreaterThan(0));
  const row = rows().find((each) => each.textContent?.trim() === name);
  if (!row) throw new Error(`the picker offers no "${name}"`);
  for (const kind of ['pointerdown', 'pointerup', 'click']) {
    row.dispatchEvent(new PointerEvent(kind, { bubbles: true, button: 0 }));
  }
}

test('the picker groups what the engine found, and names the folder it read', async () => {
  const [text] = await open();
  openPicker();
  await vi.waitFor(() => expect(rows().length).toBe(3));
  expect(rows().map((row) => row.textContent)).toEqual([
    'Vintage Electric Piano',
    'Concert Grand Piano',
    'broken.sf2',
  ]);
  // A hosted Audio Unit and a file on disk are two kinds of instrument, headed apart.
  expect(text()).toContain('Audio Unit instruments');
  expect(text()).toContain('Files');
  expect(text()).toContain('/instruments');
});

test('choosing writes the setting, loads at once, and marks the row it is on', async () => {
  await open();
  await pick('Concert Grand Piano');
  await vi.waitFor(() => expect(loads).toEqual([{ id: CONCERT.id, state: null }]));
  expect(written).toContainEqual(['instrument_id', CONCERT.id]);
  await vi.waitFor(() => expect(trigger().textContent).toContain('Concert Grand Piano'));

  openPicker();
  await vi.waitFor(() => expect(rows().length).toBe(3));
  const marked = rows().filter((row) => row.getAttribute('aria-checked') === 'true');
  expect(marked.map((row) => row.textContent)).toEqual(['Concert Grand Piano']);
});

test('a load that fails says why, where the instrument was picked', async () => {
  refusal = 'That file is not a SoundFont';
  const [text] = await open();
  await pick('broken.sf2');
  await vi.waitFor(() => expect(text()).toContain('That file is not a SoundFont'));
});

test('the picker itself says it is loading until the engine has the instrument', async () => {
  held = hold();
  await open();
  await pick('Concert Grand Piano');
  await vi.waitFor(() => expect(trigger().querySelector('[role="status"]')).not.toBeNull());
  held.release();
  await vi.waitFor(() => expect(trigger().querySelector('[role="status"]')).toBeNull());
});

test('a load that fails stops saying it is loading', async () => {
  held = hold();
  refusal = 'That file is not a SoundFont';
  const [text] = await open();
  await pick('broken.sf2');
  await vi.waitFor(() => expect(trigger().querySelector('[role="status"]')).not.toBeNull());
  held.release();
  await vi.waitFor(() => expect(text()).toContain('That file is not a SoundFont'));
  await vi.waitFor(() => expect(trigger().querySelector('[role="status"]')).toBeNull());
});

/** The rate buttons, in the order the row offers them. */
function rateButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('#setting-row-audio_sample_rate button')];
}

test('an instrument recorded at 44.1 kHz leaves no higher rate to pick', async () => {
  status = { instrument: 'Concert Grand Piano', instrument_rate: 44100 };
  await open();
  await vi.waitFor(() =>
    expect(rateButtons().map((button) => [button.textContent, button.disabled])).toEqual([
      ['44100', false],
      ['48000', true],
      ['88200', true],
      ['96000', true],
    ]),
  );
});

test('an instrument recorded below the rate in force drags the rate down to its own', async () => {
  rateSetting = 96000;
  status = { instrument: 'Concert Grand Piano', instrument_rate: 44100 };
  await open();
  await vi.waitFor(() => expect(written).toContainEqual(['audio_sample_rate', 44100]));
});

/** Boot reads these three and nothing else of the settings. */
function stored(settings: Partial<Settings>): Settings {
  return {
    instruments_folder: '',
    instrument_id: null,
    instrument_state: null,
    ...settings,
  } as Settings;
}

test('a first launch plays Logic Concert Grand without being asked', async () => {
  await restoreInstrument(stored({}));
  expect(loads).toEqual([{ id: CONCERT.id, state: null }]);
  expect(written).toEqual([['instrument_id', CONCERT.id]]);
});

test('a launch after a choice puts that one back, with the state it was left in', async () => {
  await restoreInstrument(stored({ instrument_id: BROKEN.id, instrument_state: 'YmxvYg==' }));
  expect(loads).toEqual([{ id: BROKEN.id, state: 'YmxvYg==' }]);
  expect(written).toEqual([]);
});

test('a Mac with no instrument at all loads none', async () => {
  listed = [];
  await restoreInstrument(stored({}));
  expect(loads).toEqual([]);
});
