import { InstrumentSection, restoreInstrument } from '@/audio/instrument';
import type { AudioStatus } from '@/bindings';
import { NO_STATUS } from '@/audio/sound-tab';
import { fakeRust, fakeSettings, refusal, type FakeRust } from '@/rust.fake';
import { load, type Settings } from '@/settings/settings';
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
let status: AudioStatus = NO_STATUS;
/** The rate setting in force, which an instrument recorded lower than it drags down. */
let rateSetting = 44100;

let listed = [HOSTED, CONCERT, BROKEN];
let reason: string | null = null;
let rust: FakeRust;
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

/** The settings a launch finds. No instrument here has been given an envelope. */
async function stored(settings: Partial<Settings> = {}): Promise<void> {
  fakeSettings.clear();
  fakeSettings.set('instruments_folder', '/instruments');
  fakeSettings.set('audio_sample_rate', rateSetting);
  for (const [key, value] of Object.entries(settings)) fakeSettings.set(key, value);
  await load();
}

let close: (() => void) | null = null;

beforeEach(async () => {
  listed = [HOSTED, CONCERT, BROKEN];
  status = NO_STATUS;
  rateSetting = 44100;
  reason = null;
  held = null;
  rust = fakeRust({
    audio_instruments: () => listed,
    audio_status: () => status,
    audio_load_instrument: async () => {
      if (held) await held.promise;
      if (reason) throw refusal('refused', reason);
      return status;
    },
  });
  await stored();
});

afterEach(() => {
  close?.();
  close = null;
});

/** Mounts the section and hands back the text the user can read and the section's host. */
async function open(named = 'None'): Promise<[() => string, HTMLElement]> {
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
  await vi.waitFor(() => expect(trigger().textContent).toContain(named));
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

test('the picker groups what the engine found', async () => {
  const [text] = await open();
  openPicker();
  await vi.waitFor(() => expect(rows().length).toBe(4));
  expect(rows().map((row) => row.textContent)).toEqual([
    'None',
    'Vintage Electric Piano',
    'Concert Grand Piano',
    'broken.sf2',
  ]);
  // A hosted Audio Unit and a file on disk are two kinds of instrument, headed apart.
  expect(text()).toContain('Audio Unit instruments');
  expect(text()).toContain('Files');
});

test('choosing writes the setting, loads at once, and marks the row it is on', async () => {
  await open();
  await pick('Concert Grand Piano');
  await vi.waitFor(() =>
    expect(rust.argsOf('audio_load_instrument')).toEqual([{ id: CONCERT.id }]),
  );
  expect(rust.written()).toContainEqual(['instrument_id', CONCERT.id]);
  await vi.waitFor(() => expect(trigger().textContent).toContain('Concert Grand Piano'));

  openPicker();
  await vi.waitFor(() => expect(rows().length).toBe(4));
  const marked = rows().filter((row) => row.getAttribute('aria-checked') === 'true');
  expect(marked.map((row) => row.textContent)).toEqual(['Concert Grand Piano']);
});

test('picking None takes the instrument out of the engine and keeps it out', async () => {
  await stored({ instrument_id: CONCERT.id, instrument_state: 'YmxvYg==' });
  await open('Concert Grand Piano');
  await pick('None');
  await vi.waitFor(() => expect(rust.argsOf('audio_unload_instrument')).toHaveLength(1));
  expect(rust.argsOf('audio_load_instrument')).toEqual([]);
  expect(rust.written()).toContainEqual(['instrument_id', '']);
  expect(rust.written()).toContainEqual(['instrument_state', null]);
  await vi.waitFor(() => expect(trigger().textContent).toContain('None'));

  // The next launch reads the same setting and leaves the engine as the user left it.
  await stored({ instrument_id: '' });
  expect(await restoreInstrument()).toBeNull();
  expect(rust.argsOf('audio_load_instrument')).toEqual([]);
});

test('a load that fails says why, where the instrument was picked', async () => {
  reason = 'That file is not a SoundFont';
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
  reason = 'That file is not a SoundFont';
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
  status = { ...NO_STATUS, instrument: 'Concert Grand Piano', instrument_rate: 44100 };
  const [text] = await open();
  await vi.waitFor(() =>
    expect(rateButtons().map((button) => [button.textContent, button.disabled])).toEqual([
      ['44100', false],
      ['48000', true],
      ['88200', true],
      ['96000', true],
    ]),
  );

  // The rate it was recorded at is the row's own hint and the dot on that choice, not a row of its
  // own above it.
  expect(text()).toContain('Recorded at 44.1 kHz');
  expect(text()).not.toContain('Recommended sample rate');
  expect(rateButtons().filter((button) => button.title === 'Recommended')).toHaveLength(1);
  expect(rateButtons().find((button) => button.title === 'Recommended')!.textContent).toBe('44100');
});

test('an instrument recorded below the rate in force drags the rate down to its own', async () => {
  rateSetting = 96000;
  await stored({ instrument_id: CONCERT.id });
  status = { ...NO_STATUS, instrument: 'Concert Grand Piano', instrument_rate: 44100 };
  await open('Concert Grand Piano');
  await vi.waitFor(() => expect(rust.written()).toContainEqual(['audio_sample_rate', 44100]));
});

test('a first launch plays Logic Concert Grand without being asked', async () => {
  await restoreInstrument();
  expect(rust.argsOf('audio_load_instrument')).toEqual([{ id: CONCERT.id }]);
  // The stored state belongs to the stored instrument, so a fresh default starts at its own.
  expect(rust.written()).toEqual([
    ['instrument_id', CONCERT.id],
    ['instrument_state', null],
  ]);
});

test('a launch after a choice puts that one back, and writes nothing to do it', async () => {
  await stored({ instrument_id: BROKEN.id, instrument_state: 'YmxvYg==' });
  await restoreInstrument();
  // The engine reads the state, the envelope and the role levels kept for the id itself.
  expect(rust.argsOf('audio_load_instrument')).toEqual([{ id: BROKEN.id }]);
  expect(rust.written()).toEqual([]);
});

// The name the Rust side leaves behind when a load never comes back is the whole safety net: the
// app went down inside that load, so this launch refuses the same instrument.
test('a launch after a load that never came back leaves that instrument out, and says why', async () => {
  await stored({ instrument_id: BROKEN.id, instrument_loading: BROKEN.id });
  await expect(restoreInstrument()).rejects.toThrow('did not finish loading last time');
  expect(rust.argsOf('audio_load_instrument')).toEqual([]);

  // The picker names it as the one that was left out, so the reason is on screen beside the choice.
  const [text] = await open('broken.sf2');
  await vi.waitFor(() => expect(text()).toContain('broken.sf2 did not finish loading last time'));
});

test('choosing the left-out instrument by hand is allowed, and the load clears the name', async () => {
  await stored({ instrument_id: BROKEN.id, instrument_loading: BROKEN.id });
  const [text] = await open('broken.sf2');
  await vi.waitFor(() => expect(text()).toContain('did not finish loading last time'));

  await pick('broken.sf2');
  await vi.waitFor(() => expect(rust.argsOf('audio_load_instrument')).toEqual([{ id: BROKEN.id }]));
  await vi.waitFor(() => expect(rust.written()).toContainEqual(['instrument_loading', null]));
  await vi.waitFor(() => expect(text()).not.toContain('did not finish loading last time'));
});

// A load that ends with a reason has ended, so nothing is left out at the next launch over it.
test('a load that failed with a reason leaves no name behind', async () => {
  reason = 'That file is not a SoundFont';
  const [text] = await open();
  await pick('broken.sf2');
  await vi.waitFor(() => expect(text()).toContain('That file is not a SoundFont'));
  expect(rust.written()).toContainEqual(['instrument_loading', null]);
});

test('a Mac with no instrument at all loads none', async () => {
  listed = [];
  await restoreInstrument();
  expect(rust.argsOf('audio_load_instrument')).toEqual([]);
});
