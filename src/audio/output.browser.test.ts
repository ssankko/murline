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
};
const written: [string, unknown][] = [];
vi.mock('@/db/db', () => ({
  getSettingOr: async (key: string) => settings[key],
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

test('a device plugged in while the dialog is open appears in the picker', async () => {
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

test('a chosen device that is not connected keeps its place in the picker', async () => {
  settings = { audio_output_device: 'Scarlett', audio_buffer_frames: 64 };
  devices = [{ id: 'BuiltInSpeakerDevice', name: 'MacBook Pro Speakers' }];
  status = {
    ...status,
    device: 'BuiltInSpeakerDevice',
    device_name: 'MacBook Pro Speakers',
    fallback: 'Your chosen output device is not connected; playing through the system default',
    latency_ms: 17.9,
  };

  const text = await open();
  // The picker keeps the user's choice, which is what makes the device come back when it does.
  await vi.waitFor(() => expect(text()).toContain('Scarlett'));
  // Saying where the sound went is the dialog's one line, not a second one in this section.
  expect(text()).not.toContain('not connected');
});
