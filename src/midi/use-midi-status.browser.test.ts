import type { StrikeEvent } from '@/play/engine';
import {
  hideDevice,
  setDefaultDevice,
  showDevice,
  useDevice,
  useMidiStatus,
  type MidiStatus,
} from '@/midi/use-midi-status';
import { createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeRust, fakeSettings } from '@/rust.fake';
import { load } from '@/settings/settings';
import { beforeEach, expect, test, vi } from 'vitest';

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

// The store starts once for the whole file and keeps the handlers it registered, so one fake
// stands behind every test here.
const rust = fakeRust({ midi_status: () => ports });
beforeEach(async () => {
  rust.install();
  fakeSettings.set('midi_device', '1');
  await load();
});

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
  const status = useMidiStatus((event) => struck.push(event));
  useEffect(() => {
    shown = status;
  });
  return null;
}

/** The rule the last `midi_listen` carried. */
function sent(): unknown {
  return rust.argsOf('midi_listen').at(-1)!;
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
  // The rule goes out before the first look at the ports, so what comes back is the rule's.
  const asked = rust.calls.map((one) => one.name);
  expect(asked.indexOf('midi_listen')).toBeLessThan(asked.indexOf('midi_status'));
  expect(rust.argsOf('midi_listen')[0]).toEqual({ pinned: '1', hidden: [] });
  expect(shown.defaultId).toBe('1');

  const strike: StrikeEvent = { midi: 60, velocity: 100, time: 1735689600123.5, on: true };
  rust.emit('midiStrike', strike);
  rust.emit('midiStrike', { ...strike, velocity: 0, on: false });
  expect(struck).toEqual([strike, { ...strike, velocity: 0, on: false }]);

  // A keyboard unplugged: Rust re-lists and says so, and the popover's list follows without asking.
  rust.emit('midiPorts', {
    devices: [],
    ports: [{ id: '2', name: 'IAC' }],
    pinned: '1',
    error: null,
  });
  await vi.waitFor(() => expect(shown.devices).toEqual([]));
  expect(shown.ports).toEqual([{ id: '2', name: 'IAC' }]);
});

test('every choice sends the rule again and only the lasting ones are written', async () => {
  // For this session alone: nothing is written, so the next launch is on the default again.
  useDevice('2');
  expect(sent()).toEqual({ pinned: '2', hidden: [] });
  expect(rust.written()).toEqual([]);

  // For good, and now: the session pin steps aside so the new default is what is listened to.
  setDefaultDevice('2');
  expect(rust.written()).toEqual([['midi_device', '2']]);
  expect(sent()).toEqual({ pinned: '2', hidden: [] });
  await vi.waitFor(() => expect(shown.defaultId).toBe('2'));

  // Hiding the default clears it, or the rule would open the port that was just put away.
  hideDevice('2');
  expect(rust.written().slice(1)).toEqual([
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
