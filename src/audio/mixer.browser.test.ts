import { Mixer } from '@/audio/mixer';
import type { AudioStatus } from '@/bindings';
import { NO_STATUS } from '@/audio/sound-tab';
import { fakeRust, fakeSettings, type FakeRust } from '@/rust.fake';
import { load } from '@/settings/settings';
import { createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { userEvent } from 'vitest/browser';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const PLAYING: AudioStatus = {
  ...NO_STATUS,
  available: true,
  device: 'uid:babyface',
  device_name: 'Babyface Pro',
  instrument: 'Concert Grand Piano',
};

let status: AudioStatus = PLAYING;
let rust: FakeRust;

/** The two faders as the last launch left them. */
const STORED: Record<string, unknown> = {
  keyboard_volume: 80,
  click_volume: 40,
  instruments_folder: '/instruments',
  instrument_id: 'grand',
};

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
  status = PLAYING;
  rust = fakeRust({ audio_status: () => status });
  for (const [key, value] of Object.entries(STORED)) fakeSettings.set(key, value);
  await load();
});

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
});

/** The mixer's open state belongs to the screen around it, because a search result in the settings
 * panel opens it too. This is that screen, with the status bar's volume cells for a trigger. */
function Screen({ onSoundSettings }: { onSoundSettings: () => void }) {
  const [open, setOpen] = useState(false);
  return createElement(Mixer, {
    open,
    onOpenChange: setOpen,
    onSoundSettings,
    trigger: createElement('button', { 'aria-label': 'Volume' }, '80'),
  });
}

/** Mounts the volume button, and hands back the way to open it. */
async function mount(onSoundSettings = () => {}): Promise<HTMLButtonElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(Screen, { onSoundSettings }));
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

// The write is what reaches the engine: the Rust side puts an audio setting on the running graph
// as it stores it.
test('the keyboard fader writes the setting and reaches the running engine', async () => {
  await open();
  await userEvent.fill(fader('Keyboard'), '30');

  expect(rust.written()).toContainEqual(['keyboard_volume', 30]);
});

test('the keyboard fader goes to 200 and the metronome stops at 100', async () => {
  await open();
  expect(fader('Keyboard').max).toBe('200');
  expect(fader('Metronome').max).toBe('100');

  await userEvent.fill(fader('Keyboard'), '200');
  expect(rust.written()).toContainEqual(['keyboard_volume', 200]);
});

test('the metronome fader is the click volume and touches the engine gain not at all', async () => {
  await open();
  await userEvent.fill(fader('Metronome'), '0');

  // The click volume is the app's own, so the keyboard fader is left where it was.
  expect(rust.written()).toEqual([['click_volume', 0]]);
});

test('the mixer carries the two faders and nothing that makes the sound', async () => {
  await open();

  expect(document.querySelector('button[aria-label="Instrument"]')).toBeNull();
  expect(document.body.textContent).not.toContain('Effect chain');
});

test('the line names the device and the instrument the sound is coming out of', async () => {
  await open();
  expect(document.body.textContent).toContain('Babyface Pro · Concert Grand Piano');
});

test('an engine that cannot make sound says why', async () => {
  status = { ...PLAYING, available: false, reason: 'No instrument chosen', instrument: '' };
  await userEvent.click(await mount());
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
