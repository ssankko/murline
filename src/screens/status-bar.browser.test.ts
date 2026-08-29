import { NO_STATUS } from '@/audio/sound-tab';
import { audioDot, midiDot, opensSettings, soundLabel, StatusBar } from '@/screens/status-bar';
import { createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

const PLAYING = { ...NO_STATUS, available: true, instrument: 'Concert Grand Piano' };

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
  readSettings: async () => ({ keyboard_volume: 100, click_volume: 50 }),
  getSetting: async () => null,
  getSettingOr: async (key: string) => (key === 'midi_hidden' ? [] : null),
  setSetting: async () => {},
}));

let root: Root | null = null;
let host: HTMLElement | null = null;
let opened = 0;

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  opened = 0;
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
    onSoundSettings: () => {},
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

test('the bar names what is listened to and what is playing, and each cell opens its popover', async () => {
  await mount();

  expect(cell('MIDI devices').textContent).toBe('Roland');
  expect(cell('Sound').textContent).toBe('Concert Grand Piano → AUMatrixReverb');
  expect(cell('MIDI devices').querySelector('[data-dot]')!.getAttribute('data-dot')).toBe('on');

  // Radix portals a popover out of the host, so it is looked for on the whole page.
  await userEvent.click(cell('Sound'));
  await vi.waitFor(() =>
    expect(document.querySelector('input[aria-label="Keyboard"]')).toBeTruthy(),
  );
});

test('the meters stand at a dash until the engine reports, and the load reddens past 80', async () => {
  await mount();
  const load = () => host!.querySelectorAll('.tabular-nums')[1]!;
  expect(host!.textContent).toContain('—');

  emit.get('audio-load')!({ payload: { voices: 7, load: 12 } });
  await vi.waitFor(() => expect(load().textContent).toBe('12 %'));
  expect(host!.querySelectorAll('.tabular-nums')[0]!.textContent).toBe('7');
  expect(load().className).not.toContain('red');

  emit.get('audio-load')!({ payload: { voices: 40, load: 94 } });
  await vi.waitFor(() => expect(load().className).toContain('red'));
});

test('the gear and ⌘, both ask the screen to open the settings panel', async () => {
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
