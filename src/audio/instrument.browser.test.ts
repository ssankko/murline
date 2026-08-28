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

let listed = [CONCERT, BROKEN];
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
  getSettingOr: async () => ({}),
}));

let close: (() => void) | null = null;

beforeEach(() => {
  listed = [CONCERT, BROKEN];
  refusal = null;
  held = null;
  loads = [];
  written = [];
});

afterEach(() => {
  close?.();
  close = null;
});

/** Mounts the section and hands back its picker, the text the user can read, and its host. */
async function open(): Promise<[HTMLSelectElement, () => string, HTMLElement]> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(InstrumentSection, {}));
  close = () => {
    root.unmount();
    host.remove();
  };
  const text = (): string => host.textContent ?? '';
  await vi.waitFor(() => expect(text()).toContain('Concert Grand Piano'));
  return [host.querySelector('select')!, text, host];
}

/** React listens for change on the element itself, so the value moves and the event follows it. */
function pick(picker: HTMLSelectElement, id: string): void {
  picker.value = id;
  picker.dispatchEvent(new Event('change', { bubbles: true }));
}

test('the picker lists what the engine found, and the folder it read', async () => {
  const [picker, text] = await open();
  expect([...picker.options].map((option) => option.textContent)).toEqual([
    'None',
    'Concert Grand Piano',
    'broken.sf2',
  ]);
  expect(text()).toContain('/instruments');
});

test('choosing writes the setting and loads at once', async () => {
  const [picker] = await open();
  pick(picker, CONCERT.id);
  await vi.waitFor(() => expect(loads).toEqual([{ id: CONCERT.id, state: null }]));
  expect(written).toContainEqual(['instrument_id', CONCERT.id]);
});

test('a load that fails says why, where the instrument was picked', async () => {
  refusal = 'That file is not a SoundFont';
  const [picker, text] = await open();
  pick(picker, BROKEN.id);
  await vi.waitFor(() => expect(text()).toContain('That file is not a SoundFont'));
});

test('the row says it is loading until the engine has the instrument', async () => {
  held = hold();
  const [picker, , host] = await open();
  pick(picker, CONCERT.id);
  await vi.waitFor(() => expect(host.querySelector('[role="status"]')).not.toBeNull());
  held.release();
  await vi.waitFor(() => expect(host.querySelector('[role="status"]')).toBeNull());
});

test('a load that fails stops saying it is loading', async () => {
  held = hold();
  refusal = 'That file is not a SoundFont';
  const [picker, text, host] = await open();
  pick(picker, BROKEN.id);
  await vi.waitFor(() => expect(host.querySelector('[role="status"]')).not.toBeNull());
  held.release();
  await vi.waitFor(() => expect(text()).toContain('That file is not a SoundFont'));
  expect(host.querySelector('[role="status"]')).toBeNull();
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
