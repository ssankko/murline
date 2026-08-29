import { OutputSection } from '@/audio/output';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let devices = [
  { id: 'BuiltInSpeakerDevice', name: 'MacBook Pro Speakers' },
  { id: 'Scarlett', name: 'Scarlett 2i2' },
];
let status = {
  available: true,
  reason: '',
  device: 'Scarlett',
  device_name: 'Scarlett 2i2',
  fallback: '',
  buffer_frames: 64,
  sample_rate: 48000,
  latency_ms: 1.9,
};
const sent: [string, unknown][] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: unknown) => {
    sent.push([command, args]);
    if (command === 'audio_output_devices') return devices;
    if (command === 'audio_status') return status;
    if (command === 'audio_set_output_device' || command === 'audio_set_buffer_frames') return;
    // The voice limit reloads the instrument, because its streaming rings come with it.
    if (command === 'audio_set_voices' || command === 'audio_load_instrument') return;
    if (command === 'audio_instruments') return [];
    throw new Error(`unexpected command ${command}`);
  },
}));

/** The engine's devices-changed handler, so a test can plug something in. */
let announce: (() => void) | null = null;
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_name: string, handler: () => void) => {
    announce = handler;
    return () => {
      announce = null;
    };
  },
}));

let settings: Record<string, unknown> = {
  audio_output_device: 'Scarlett',
  audio_buffer_frames: 64,
  audio_voices: 128,
  instrument_id: 'file:/Steinway.exs',
  instrument_state: null,
  instruments_folder: '/instruments',
  instrument_envelopes: {},
  instrument_roles: {},
};
const written: [string, unknown][] = [];
vi.mock('@/db/db', () => ({
  getSettingOr: async (key: string) => settings[key],
  readSettings: async () => settings,
  setSetting: async (key: string, value: unknown) => {
    written.push([key, value]);
  },
}));

let close: (() => void) | null = null;

beforeEach(() => {
  sent.length = 0;
  written.length = 0;
});

afterEach(() => {
  close?.();
  close = null;
});

/** Mounts the section and hands back the text the user can read on the page. */
async function open(): Promise<() => string> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(OutputSection));
  close = () => {
    root.unmount();
    host.remove();
  };
  const text = (): string => document.body.textContent ?? '';
  await vi.waitFor(() => expect(text()).toContain('Output'));
  return text;
}

/** Opens the device picker, whose rows are a portal beside the section. */
function openPicker(): void {
  const trigger = document.querySelector('[aria-label="Output device"]');
  trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
}

/** The picker row the radio dot is on, once the picker is open. */
function checkedRow(): string {
  const found = document.querySelector('[role="menuitemradio"][aria-checked="true"]');
  return found?.textContent?.trim() ?? '';
}

function clickText(label: string): void {
  const found = [...document.querySelectorAll('button, [role="menuitemradio"]')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!found) throw new Error(`nothing to click reads "${label}"`);
  for (const kind of ['pointerdown', 'pointerup', 'click']) {
    found.dispatchEvent(new PointerEvent(kind, { bubbles: true, button: 0 }));
  }
}

test('the section shows the chosen device and what the engine says it costs', async () => {
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain('Scarlett 2i2'));
  expect(text()).toContain('1.9 ms at 48.0 kHz');

  openPicker();
  await vi.waitFor(() => expect(text()).toContain('MacBook Pro Speakers'));
  expect(text()).toContain('System default');
});

test('a device plugged in while the tab is open appears in the picker', async () => {
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain('Scarlett 2i2'));

  devices = [...devices, { id: 'Headphones', name: 'External Headphones' }];
  announce?.();

  openPicker();
  await vi.waitFor(() => expect(text()).toContain('External Headphones'));
});

test('choosing a device writes the setting and moves the engine', async () => {
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain('Scarlett 2i2'));

  openPicker();
  await vi.waitFor(() => expect(text()).toContain('MacBook Pro Speakers'));
  clickText('MacBook Pro Speakers');

  await vi.waitFor(() =>
    expect(sent).toContainEqual(['audio_set_output_device', { id: 'BuiltInSpeakerDevice' }]),
  );
  expect(written).toContainEqual(['audio_output_device', 'BuiltInSpeakerDevice']);
});

test('choosing a buffer size writes the setting and applies it', async () => {
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain('Scarlett 2i2'));

  clickText('128');

  await vi.waitFor(() => expect(sent).toContainEqual(['audio_set_buffer_frames', { frames: 128 }]));
  expect(written).toContainEqual(['audio_buffer_frames', 128]);
  // The readout is asked again, because the buffer is most of what the latency is.
  await vi.waitFor(() =>
    expect(sent.filter(([command]) => command === 'audio_status').length).toBeGreaterThan(1),
  );
});

test('choosing a voice limit writes the setting and loads the instrument again at it', async () => {
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain('Scarlett 2i2'));

  clickText('512');

  await vi.waitFor(() => expect(sent).toContainEqual(['audio_set_voices', { count: 512 }]));
  expect(written).toContainEqual(['audio_voices', 512]);
  // The streaming rings are allocated with the instrument, so it goes in again at the new count.
  expect(sent.map(([command]) => command)).toContain('audio_load_instrument');
});

test('a chosen device that is not connected reads as the system default until it is back', async () => {
  settings = { ...settings, audio_output_device: 'Scarlett', audio_buffer_frames: 64 };
  devices = [{ id: 'BuiltInSpeakerDevice', name: 'MacBook Pro Speakers' }];
  status = {
    ...status,
    device: 'BuiltInSpeakerDevice',
    device_name: 'MacBook Pro Speakers',
    fallback: 'Your chosen output device is not connected; playing through the system default',
    latency_ms: 17.9,
  };

  const text = await open();
  // The latency figure is the engine answering, by which point the setting has been read too.
  await vi.waitFor(() => expect(text()).toContain('17.9 ms'));
  // Neither the device's name nor the id it was stored under is anywhere on the page.
  expect(text()).not.toContain('Scarlett');

  openPicker();
  await vi.waitFor(() => expect(text()).toContain('MacBook Pro Speakers'));
  expect(checkedRow()).toBe('System default');
  // Saying where the sound went is the tab's one line, not a second one in this section.
  expect(text()).not.toContain('not connected');

  // The setting kept the choice, so plugging the device back in shows its name again.
  devices = [...devices, { id: 'Scarlett', name: 'Scarlett 2i2' }];
  announce?.();

  await vi.waitFor(() => expect(checkedRow()).toBe('Scarlett 2i2'));
});
