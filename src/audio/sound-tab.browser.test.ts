import { SoundTab } from '@/audio/sound-tab';
import type { StrikeEvent } from '@/play/engine';
import { NO_STATUS, type AudioStatus, type Envelope } from '@/rust';
import { fakeRust } from '@/rust.fake';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const SILENT: AudioStatus = { ...NO_STATUS, reason: 'No instrument chosen' };

let answer: AudioStatus = SILENT;
let envelope: Envelope | null = null;

beforeEach(() => {
  // A Mac with nothing installed: no device, no instrument, no effect to add.
  fakeRust({
    audio_status: () => answer,
    audio_envelope: () => envelope,
    audio_output_devices: () => [],
    audio_instruments: () => [],
  });
});

/** The tab's own ear on the keyboard, which a test plays by hand. */
let strike: ((event: StrikeEvent) => void) | undefined;
vi.mock('@/midi/use-midi-status', () => ({
  useMidiStatus: (onStrike?: (event: StrikeEvent) => void) => {
    strike = onStrike;
    return { devices: [], ports: [], error: null };
  },
}));

let close: (() => void) | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  close?.();
  close = null;
  host = null;
  answer = SILENT;
  envelope = null;
});

/** Mounts the tab and hands back the text the user can read in it. */
async function open(): Promise<() => string> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(SoundTab, {}));
  close = () => {
    root.unmount();
    host?.remove();
  };
  const text = (): string => host?.textContent ?? '';
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
  answer = { ...NO_STATUS, available: true };
  const text = await open();
  expect(text()).not.toContain('No instrument chosen');
});

test('an engine playing somewhere other than the chosen device says so on the same line', async () => {
  const moved = 'Your chosen output device is not connected; playing through the system default';
  answer = { ...NO_STATUS, available: true, fallback: moved };
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain(moved));
});

test('silence outranks a fallback, so the line says why there is no sound', async () => {
  answer = {
    ...SILENT,
    fallback: 'Your chosen output device is not connected; playing through the system default',
  };
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain('No instrument chosen'));
  expect(text()).not.toContain('not connected');
});

test('a search result marks the row it named, wherever in the tab it lives', async () => {
  answer = { ...NO_STATUS, available: true };
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

test('both plots let go of a key together, once the envelope has finished with it', async () => {
  answer = { ...NO_STATUS, available: true };
  envelope = { attack: 0.01, decay: 0.05, sustain: 0.8, release: 0.3 };
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain('Envelope'));

  const marks = () => host!.querySelectorAll('[data-strike], [data-head]').length;
  strike!({ midi: 60, velocity: 80, time: 0, on: true });
  // One on the touch plot at the height it was struck, one walking the envelope.
  await vi.waitFor(() => expect(marks()).toBe(2));

  // Still drawn a third of the way through the release, and gone by the end of it.
  strike!({ midi: 60, velocity: 0, time: 0, on: false });
  await new Promise((done) => setTimeout(done, 100));
  expect(marks()).toBe(2);
  await vi.waitFor(() => expect(marks()).toBe(0), { timeout: 2000 });
});
