import { NO_STATUS } from '@/audio/sound-tab';
import {
  audioDot,
  latencyLabel,
  midiDot,
  opensSettings,
  soundLabel,
  StatusBar,
} from '@/screens/status-bar';
import { createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

const PLAYING = {
  ...NO_STATUS,
  available: true,
  instrument: 'Concert Grand Piano',
  buffer_frames: 256,
  sample_rate: 44100,
  latency_ms: 12,
};

test('the MIDI dot is green while a keyboard is listened to and red when MIDI is unreachable', () => {
  expect(midiDot(['Roland'], null)).toBe('on');
  expect(midiDot([], null)).toBe('off');
  expect(midiDot(['Roland'], 'MIDI is unavailable')).toBe('bad');
});

test('the audio dot is red while the sound is down or has fallen back to another device', () => {
  expect(audioDot(PLAYING)).toBe('on');
  expect(audioDot({ ...PLAYING, instrument: '' })).toBe('off');
  expect(audioDot({ ...NO_STATUS, reason: 'No sound engine on this platform' })).toBe('bad');
  expect(audioDot({ ...PLAYING, fallback: 'Your chosen device is not connected' })).toBe('bad');
  // Nothing has answered yet, which is not something to alarm anyone about.
  expect(audioDot(null)).toBe('off');
});

test('the sound line names the instrument and the effects after it, in the order they play', () => {
  const chain = [slot('Chorus'), slot('AUMatrixReverb')];
  expect(soundLabel(PLAYING, chain)).toBe('Concert Grand Piano → Chorus → AUMatrixReverb');
  expect(soundLabel(PLAYING, [])).toBe('Concert Grand Piano');
  expect(soundLabel({ ...PLAYING, instrument: '' }, chain)).toBe(
    'No instrument → Chorus → AUMatrixReverb',
  );
  // A dead engine has no chain worth naming; it says why it is silent instead.
  expect(soundLabel({ ...NO_STATUS, reason: 'No output device' }, chain)).toBe('No output device');
});

test('the latency tooltip names the buffer and the rate the milliseconds come from', () => {
  expect(latencyLabel(PLAYING)).toBe('Output latency: 256 frames at 44.1 kHz');
  expect(latencyLabel({ ...PLAYING, sample_rate: 48000, buffer_frames: 512 })).toBe(
    'Output latency: 512 frames at 48 kHz',
  );
  expect(latencyLabel(null)).toBe('Output latency');
  expect(latencyLabel(NO_STATUS)).toBe('Output latency');
});

test('the settings shortcut stands back for a text field and for an open dialog', () => {
  expect(opensSettings(press({ metaKey: true, key: ',' }), false)).toBe(true);
  expect(opensSettings(press({ key: ',' }), false)).toBe(false);
  expect(opensSettings(press({ metaKey: true, key: 'k' }), false)).toBe(false);
  expect(opensSettings(press({ metaKey: true, key: ',' }), true)).toBe(false);
  expect(opensSettings(press({ metaKey: true, key: ',', tagName: 'INPUT' }), false)).toBe(false);
  expect(opensSettings(press({ metaKey: true, key: ',', tagName: 'TEXTAREA' }), false)).toBe(false);
  expect(
    opensSettings(press({ metaKey: true, key: ',', tagName: 'DIV', editable: true }), false),
  ).toBe(false);
  // The bar's own button is a button: a shortcut pressed with one focused still opens the panel.
  expect(opensSettings(press({ metaKey: true, key: ',', tagName: 'BUTTON' }), false)).toBe(true);
});

/** The event handlers the bar subscribed with, so a test can be the engine. */
const emit = new Map<string, (event: { payload: unknown }) => void>();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'audio_status') return PLAYING;
    if (command === 'audio_chain') return [{ id: 'reverb', name: 'AUMatrixReverb' }];
    if (command === 'midi_status') return { devices: ['Roland'], ports: [], pinned: null };
    if (command === 'midi_listen') return null;
    // What the mixer's instrument picker and effect chain ask for once it is opened.
    if (command === 'audio_instruments') return [];
    if (command === 'audio_effects') return [];
    if (command === 'audio_set_chain') return [];
    throw new Error(`unexpected command ${command}`);
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    emit.set(name, handler);
    return () => emit.delete(name);
  },
}));

vi.mock('@/db/db', () => ({
  readSettings: async () => ({
    keyboard_volume: 100,
    click_volume: 50,
    instruments_folder: '/instruments',
    instrument_id: null,
    instrument_state: null,
  }),
  getSetting: async () => null,
  getSettingOr: async () => [],
  setSetting: async () => {},
}));

let root: Root | null = null;
let host: HTMLElement | null = null;
let opened = 0;
let sound = 0;

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  opened = 0;
  sound = 0;
});

/** The screen around the bar, which is what holds the two popovers open or shut. */
function Screen() {
  const [midiOpen, onMidiOpen] = useState(false);
  const [mixerOpen, onMixerOpen] = useState(false);
  return createElement(StatusBar, {
    midiOpen,
    onMidiOpen,
    mixerOpen,
    onMixerOpen,
    onOpenSettings: () => opened++,
    onSoundSettings: () => sound++,
  });
}

async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(Screen));
  await vi.waitFor(() => expect(cell('Sound').textContent).toContain('Concert Grand Piano'));
}

function cell(label: string): HTMLButtonElement {
  return host!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
}

/** The numbers of the right group, in the order they stand: the two volumes, then the meters. */
function num(at: number): Element {
  return host!.querySelectorAll('.tabular-nums')[at]!;
}

test('the bar names what is listened to and what is playing, and the sound cell asks for the Sound tab', async () => {
  await mount();

  expect(cell('MIDI devices').textContent).toBe('Roland');
  expect(cell('Sound').textContent).toBe('Concert Grand Piano → AUMatrixReverb');
  expect(cell('MIDI devices').querySelector('[data-dot]')!.getAttribute('data-dot')).toBe('on');

  await userEvent.click(cell('Sound'));
  expect(sound).toBe(1);

  // The cell is a popover trigger inside its tooltip trigger, so the click has to reach through
  // both. Radix portals the popover out of the host.
  await userEvent.click(cell('MIDI devices'));
  await vi.waitFor(() => expect(document.body.textContent).toContain('Listening to Roland'));
});

test('the volume pair reads the two settings and opens the mixer', async () => {
  await mount();
  await vi.waitFor(() => expect(num(0).textContent).toBe('100'));
  expect(num(1).textContent).toBe('50');

  // Radix portals a popover out of the host, so it is looked for on the whole page.
  await userEvent.click(cell('Volume'));
  await vi.waitFor(() =>
    expect(document.querySelector('input[aria-label="Keyboard"]')).toBeTruthy(),
  );
});

test('the meters stand at a dash until the engine reports, and the load reddens past 80', async () => {
  await mount();
  // Latency comes with the status; the voices and the load wait for the render block to report.
  await vi.waitFor(() => expect(num(2).textContent).toBe('12 ms'));
  expect(num(3).textContent).toBe('—');
  expect(num(4).textContent).toBe('—');

  emit.get('audio-load')!({ payload: { voices: 41, limit: 128, load: 12 } });
  await vi.waitFor(() => expect(num(4).textContent).toBe('12 %'));
  expect(num(3).textContent).toBe('41 / 128');
  expect(num(4).className).not.toContain('red');

  emit.get('audio-load')!({ payload: { voices: 40, limit: 128, load: 94 } });
  await vi.waitFor(() => expect(num(4).className).toContain('red'));
});

test('the cog and ⌘, both ask the screen to open the settings panel', async () => {
  await mount();

  await userEvent.click(cell('Settings'));
  expect(opened).toBe(1);

  window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', metaKey: true }));
  expect(opened).toBe(2);
});

function slot(name: string) {
  return { id: name, name, bypass: false, state: '' };
}

/** A key press as the window handler sees it, with only the parts the guard reads. */
function press({
  key,
  metaKey = false,
  tagName,
  editable = false,
}: {
  key: string;
  metaKey?: boolean;
  tagName?: string;
  editable?: boolean;
}): KeyboardEvent {
  const target = tagName ? { tagName, isContentEditable: editable } : null;
  return { key, metaKey, target } as unknown as KeyboardEvent;
}
