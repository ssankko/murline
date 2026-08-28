import { TooltipProvider } from '@/components/ui/tooltip';
import { MidiLight } from '@/midi/midi-light';
import type { MidiStatus } from '@/midi/use-midi-status';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';

const emit = new Map<string, (event: { payload: unknown }) => void>();

const connected: MidiStatus = {
  devices: ['Roland', 'IAC'],
  ports: [
    { id: '1', name: 'Roland' },
    { id: '2', name: 'IAC' },
  ],
  error: null,
};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'midi_status') return connected;
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

vi.mock('@/db/db', () => ({ getSetting: async () => null }));

test('the light names the keyboards, dims without one or on an error, and opens settings', async () => {
  let opened = 0;
  const host = document.createElement('div');
  document.body.append(host);
  createRoot(host).render(
    createElement(TooltipProvider, null, createElement(MidiLight, { onOpenSettings: () => opened++ })),
  );
  const light = () => host.querySelector('button')!;
  // The tooltip's text is the button's label.
  const label = () => light().getAttribute('aria-label');
  const dimmed = () => light().classList.contains('text-ink/35');

  await vi.waitFor(() => expect(label()).toBe('Roland, IAC'));
  expect(dimmed()).toBe(false);

  emit.get('midi-ports')!({ payload: { devices: [], ports: [], error: null } });
  await vi.waitFor(() => expect(label()).toBe('No MIDI device'));
  expect(dimmed()).toBe(true);

  emit.get('midi-ports')!({ payload: { devices: [], ports: [], error: 'CoreMIDI is down' } });
  await vi.waitFor(() => expect(label()).toBe('CoreMIDI is down'));
  expect(dimmed()).toBe(true);

  light().click();
  expect(opened).toBe(1);
});
