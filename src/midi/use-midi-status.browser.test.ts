import type { StrikeEvent } from '@/play/engine';
import {
  hideDevice,
  setDefaultDevice,
  showDevice,
  useDevice,
  useMidiStatus,
  type MidiStatus,
} from '@/midi/use-midi-status';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';

const invoked: { command: string; args: unknown }[] = [];
const written: [string, unknown][] = [];
const emit = new Map<string, (event: { payload: unknown }) => void>();

/** What Rust answers with. The default and the hidden list are settings the store holds itself. */
let ports: Omit<MidiStatus, 'defaultId' | 'hidden'> = {
  devices: ['Roland'],
  ports: [
    { id: '1', name: 'Roland' },
    { id: '2', name: 'IAC' },
  ],
  pinned: '1',
  error: null,
};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: unknown) => {
    invoked.push({ command, args });
    if (command === 'midi_status') return ports;
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
  getSettingOr: async (key: string) => (key === 'midi_device' ? '1' : []),
  setSetting: async (key: string, value: unknown) => {
    written.push([key, value]);
  },
}));

const struck: StrikeEvent[] = [];
let shown: MidiStatus = {
  devices: [],
  ports: [],
  pinned: null,
  defaultId: null,
  hidden: [],
  error: null,
};

function Probe() {
  shown = useMidiStatus((event) => struck.push(event));
  return null;
}

/** The rule the last `midi_listen` carried. */
function sent(): unknown {
  return invoked.filter((each) => each.command === 'midi_listen').at(-1)!.args;
}

test('the ports and every strike come off the Rust events in the shape they always had', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  createRoot(host).render(createElement(Probe));

  await vi.waitFor(() => expect(shown.devices).toEqual(['Roland']));
  expect(shown.ports).toEqual([
    { id: '1', name: 'Roland' },
    { id: '2', name: 'IAC' },
  ]);
  expect(shown.error).toBe(null);
  // Rust keeps no settings, so the rule goes out before the first look at the ports.
  expect(invoked[0]).toEqual({ command: 'midi_listen', args: { pinned: '1', hidden: [] } });
  expect(shown.defaultId).toBe('1');

  const strike: StrikeEvent = { midi: 60, velocity: 100, time: 1735689600123.5, on: true };
  emit.get('midi-strike')!({ payload: strike });
  emit.get('midi-strike')!({ payload: { ...strike, velocity: 0, on: false } });
  expect(struck).toEqual([strike, { ...strike, velocity: 0, on: false }]);

  // A keyboard unplugged: Rust re-lists and says so, and the popover's list follows without asking.
  emit.get('midi-ports')!({
    payload: { devices: [], ports: [{ id: '2', name: 'IAC' }], pinned: '1', error: null },
  });
  await vi.waitFor(() => expect(shown.devices).toEqual([]));
  expect(shown.ports).toEqual([{ id: '2', name: 'IAC' }]);
});

test('every choice sends the rule again and only the lasting ones are written', async () => {
  // For this session alone: nothing is written, so the next launch is on the default again.
  useDevice('2');
  expect(sent()).toEqual({ pinned: '2', hidden: [] });
  expect(written).toEqual([]);

  // For good, and now: the session pin steps aside so the new default is what is listened to.
  setDefaultDevice('2');
  expect(written).toEqual([['midi_device', '2']]);
  expect(sent()).toEqual({ pinned: '2', hidden: [] });
  await vi.waitFor(() => expect(shown.defaultId).toBe('2'));

  // Hiding the default clears it, or the rule would open the port that was just put away.
  hideDevice('2');
  expect(written.slice(1)).toEqual([
    ['midi_device', null],
    ['midi_hidden', ['2']],
  ]);
  expect(sent()).toEqual({ pinned: null, hidden: ['2'] });
  await vi.waitFor(() => expect(shown.hidden).toEqual(['2']));
  expect(shown.defaultId).toBe(null);

  // Hiding the one in use drops the session pin the same way.
  useDevice('1');
  expect(sent()).toEqual({ pinned: '1', hidden: ['2'] });
  hideDevice('1');
  expect(sent()).toEqual({ pinned: null, hidden: ['2', '1'] });

  showDevice('1');
  expect(sent()).toEqual({ pinned: null, hidden: ['2'] });
  await vi.waitFor(() => expect(shown.hidden).toEqual(['2']));
});
