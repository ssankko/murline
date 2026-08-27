import { Mixer } from '@/audio/mixer';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { userEvent } from 'vitest/browser';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const PLAYING = {
  available: true,
  reason: '',
  device: 'uid:babyface',
  device_name: 'Babyface Pro',
  instrument: 'Concert Grand Piano',
  fallback: '',
};

let status: unknown = PLAYING;
let sent: [string, unknown][] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    sent.push([command, args]);
    if (command === 'audio_status') return status;
    if (command === 'audio_set_keyboard_volume') return null;
    throw new Error(`unexpected command ${command}`);
  },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

let stored: Record<string, number> = { keyboard_volume: 80, click_volume: 40 };
let written: [string, unknown][] = [];

// The status hook lives beside the Sound tab, so the tab's own sections come in behind it and
// their reads have to resolve even though nothing here mounts one.
vi.mock('@/db/db', () => ({
  readSettings: async () => stored,
  getSettingOr: async (_key: string, fallback: unknown) => fallback,
  setSetting: async (key: string, value: unknown) => {
    written.push([key, value]);
  },
}));

let root: Root | null = null;
let host: HTMLElement | null = null;
let changed: [string, unknown][] = [];

beforeEach(() => {
  status = PLAYING;
  sent = [];
  written = [];
  changed = [];
  stored = { keyboard_volume: 80, click_volume: 40 };
});

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
});

/** Mounts the volume button, and hands back the way to open it. */
async function mount(onSoundSettings = () => {}): Promise<HTMLButtonElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(
    createElement(Mixer, {
      onSoundSettings,
      onGlobalChange: (...change: [string, unknown]) => changed.push(change),
    }),
  );
  await vi.waitFor(() =>
    expect(host!.querySelector('button[aria-label="Volume"]')).toBeTruthy(),
  );
  return host.querySelector<HTMLButtonElement>('button[aria-label="Volume"]')!;
}

/** The popover is portalled out of the host, so everything inside it is looked up on the page. */
function fader(label: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

async function open(onSoundSettings = () => {}): Promise<void> {
  await userEvent.click(await mount(onSoundSettings));
  await vi.waitFor(() => expect(fader('Keyboard').value).toBe('80'));
}

test('the mixer opens on the two faders as they were last left', async () => {
  await open();
  expect(fader('Keyboard').value).toBe('80');
  expect(fader('Metronome').value).toBe('40');

  // The two attributes the play screen watches to keep Space and Escape off the clock while
  // anything is open over it.
  expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeTruthy();
});

test('the keyboard fader writes the setting and reaches the running engine', async () => {
  await open();
  await userEvent.fill(fader('Keyboard'), '30');

  expect(written).toContainEqual(['keyboard_volume', 30]);
  expect(sent).toContainEqual(['audio_set_keyboard_volume', { percent: 30 }]);
});

test('the metronome fader is the click volume and touches the engine gain not at all', async () => {
  await open();
  await userEvent.fill(fader('Metronome'), '0');

  expect(written).toContainEqual(['click_volume', 0]);
  // The play screen's metronome reads it live, so the change has to be handed on.
  expect(changed).toContainEqual(['click_volume', 0]);
  expect(sent.map(([command]) => command)).not.toContain('audio_set_keyboard_volume');
});

test('the line names the device and the instrument the sound is coming out of', async () => {
  await open();
  expect(document.body.textContent).toContain('Babyface Pro · Concert Grand Piano');
  expect(document.querySelector('button[aria-label="Volume"]')!.getAttribute('data-engine')).toBe(
    null,
  );
});

test('an engine that cannot make sound says why, and the button says so unopened', async () => {
  status = { ...PLAYING, available: false, reason: 'No instrument chosen', instrument: '' };
  const button = await mount();
  await vi.waitFor(() => expect(button.dataset.engine).toBe('down'));
  expect(button.title).toBe('No instrument chosen');

  await userEvent.click(button);
  await vi.waitFor(() => expect(document.body.textContent).toContain('No instrument chosen'));
});

test('the way into the Sound tab closes the mixer behind it', async () => {
  const opened: number[] = [];
  await open(() => opened.push(1));

  await userEvent.click(
    [...document.querySelectorAll('button')].find(
      (each) => each.textContent === 'Sound settings…',
    )!,
  );

  expect(opened).toEqual([1]);
  await vi.waitFor(() => expect(document.querySelector('input[aria-label="Keyboard"]')).toBeNull());
});
