import { SoundTab } from '@/audio/sound-tab';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

let answer: unknown = { available: false, reason: 'No instrument chosen' };

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'audio_status') return answer;
    if (command === 'audio_output_devices') return [];
    if (command === 'audio_set_output_device' || command === 'audio_set_buffer_frames') return;
    if (command === 'audio_instruments') return [];
    if (command === 'audio_effects') return [];
    if (command === 'audio_set_chain') return [];
    throw new Error(`unexpected command ${command}`);
  },
}));
// The Output section follows the engine's device-list event; nothing here plugs anything in.
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

let close: (() => void) | null = null;

afterEach(() => {
  close?.();
  close = null;
});

/** Mounts the tab and hands back the text the user can read in it. */
async function open(): Promise<() => string> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(SoundTab, {}));
  close = () => {
    root.unmount();
    host.remove();
  };
  const text = (): string => host.textContent ?? '';
  await vi.waitFor(() => expect(text()).toContain('Effect chain'));
  return text;
}

test('the tab holds its three sections and the reason there is no sound', async () => {
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain('No instrument chosen'));
  for (const section of ['Output', 'Instrument', 'Effect chain']) {
    expect(text()).toContain(section);
  }
});

test('an engine that can play says nothing about why it cannot', async () => {
  answer = { available: true, reason: '', fallback: '' };
  const text = await open();
  expect(text()).not.toContain('No instrument chosen');
});

test('an engine playing somewhere other than the chosen device says so on the same line', async () => {
  const moved = 'Your chosen output device is not connected; playing through the system default';
  answer = { available: true, reason: '', fallback: moved };
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain(moved));
});

test('silence outranks a fallback, so the line says why there is no sound', async () => {
  answer = {
    available: false,
    reason: 'No instrument chosen',
    fallback: 'Your chosen output device is not connected; playing through the system default',
  };
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain('No instrument chosen'));
  expect(text()).not.toContain('not connected');
});

test('a search result marks the row it named, wherever in the tab it lives', async () => {
  answer = { available: true, reason: '', fallback: '' };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(SoundTab, { marked: 'audio_buffer_frames' }));
  close = () => {
    root.unmount();
    host.remove();
  };

  await vi.waitFor(() =>
    expect(host.querySelector('#setting-row-audio_buffer_frames')?.getAttribute('data-marked')).toBe(
      'true',
    ),
  );
  for (const id of ['audio_output_device', 'instrument_id', 'instruments_folder', 'effect_chain']) {
    expect(host.querySelector(`#setting-row-${id}`), id).toBeTruthy();
  }
});
