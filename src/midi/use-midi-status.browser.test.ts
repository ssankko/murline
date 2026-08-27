import type { StrikeEvent } from '@/play/engine';
import { type MidiStatus, pinMidiDevice, useMidiStatus } from '@/midi/use-midi-status';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';

const invoked: { command: string; args: unknown }[] = [];
const emit = new Map<string, (event: { payload: unknown }) => void>();

let ports: MidiStatus = {
  devices: ['Roland'],
  ports: [
    { id: '1', name: 'Roland' },
    { id: '2', name: 'IAC' },
  ],
  error: null,
};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: unknown) => {
    invoked.push({ command, args });
    if (command === 'midi_status') return ports;
    if (command === 'midi_pin') return null;
    throw new Error(`unexpected command ${command}`);
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    emit.set(name, handler);
    return () => emit.delete(name);
  },
}));

vi.mock('@/db/db', () => ({ getSetting: async () => '1' }));

const struck: StrikeEvent[] = [];
let shown: MidiStatus = { devices: [], ports: [], error: null };

function Probe() {
  shown = useMidiStatus((event) => struck.push(event));
  return null;
}

test('the ports, the pin and every strike come off the Rust events in the shape they always had', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  createRoot(host).render(createElement(Probe));

  await vi.waitFor(() => expect(shown.devices).toEqual(['Roland']));
  expect(shown.ports).toEqual([
    { id: '1', name: 'Roland' },
    { id: '2', name: 'IAC' },
  ]);
  expect(shown.error).toBe(null);
  // The pinned setting is Rust's only way of knowing it, so it goes out before the first look.
  expect(invoked[0]).toEqual({ command: 'midi_pin', args: { id: '1' } });

  const strike: StrikeEvent = { midi: 60, velocity: 100, time: 1735689600123.5, on: true };
  emit.get('midi-strike')!({ payload: strike });
  emit.get('midi-strike')!({ payload: { ...strike, velocity: 0, on: false } });
  expect(struck).toEqual([strike, { ...strike, velocity: 0, on: false }]);

  // A keyboard unplugged: Rust re-lists and says so, and the dialog's list follows without asking.
  emit.get('midi-ports')!({ payload: { devices: [], ports: [{ id: '2', name: 'IAC' }], error: null } });
  await vi.waitFor(() => expect(shown.devices).toEqual([]));
  expect(shown.ports).toEqual([{ id: '2', name: 'IAC' }]);

  pinMidiDevice(null);
  await vi.waitFor(() =>
    expect(invoked.at(-1)).toEqual({ command: 'midi_pin', args: { id: null } }),
  );
});
