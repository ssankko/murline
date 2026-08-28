import { TooltipProvider } from '@/components/ui/tooltip';
import { MidiLight } from '@/midi/midi-light';
import type { MidiStatus } from '@/midi/use-midi-status';
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';

const invoked: { command: string; args: unknown }[] = [];
const written: [string, unknown][] = [];
const emit = new Map<string, (event: { payload: unknown }) => void>();

const connected: Omit<MidiStatus, 'defaultId' | 'hidden'> = {
  devices: ['Roland', 'IAC'],
  ports: [
    { id: '1', name: 'Roland' },
    { id: '2', name: 'IAC' },
  ],
  pinned: null,
  error: null,
};

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: unknown) => {
    invoked.push({ command, args });
    if (command === 'midi_status') return connected;
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
  getSettingOr: async (key: string) => (key === 'midi_device' ? null : []),
  setSetting: async (key: string, value: unknown) => {
    written.push([key, value]);
  },
}));

/** The one open popover on the page. Radix puts it in a portal, so ask the whole page. */
function popover(): HTMLElement | null {
  return document.querySelector('[data-slot="popover-content"]');
}

/** The rule the last `midi_listen` carried. */
function sent(): unknown {
  return invoked.filter((each) => each.command === 'midi_listen').at(-1)!.args;
}

/** What the popover offers to listen on, in the order it lists them. */
function listed(): string[] {
  return [...document.querySelectorAll('[aria-label^="Use "]')].map((each) =>
    each.getAttribute('aria-label')!.slice(4),
  );
}

function button(label: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
}

/** Rust answering the last change: what it opened, and the pin it opened on. */
function relisted(devices: string[], pinned: string | null): void {
  emit.get('midi-ports')!({ payload: { ...connected, devices, pinned } });
}

function Screen() {
  const [open, setOpen] = useState(false);
  return createElement(
    TooltipProvider,
    null,
    createElement(MidiLight, { open, onOpenChange: setOpen }),
  );
}

test('the popover says what is listened to and takes Use, Default, Hide and Show', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  createRoot(host).render(createElement(Screen));

  const light = () => host.querySelector('button')!;
  // The tooltip's text is the button's label.
  const label = () => light().getAttribute('aria-label');
  const dimmed = () => light().classList.contains('text-ink/35');

  await vi.waitFor(() => expect(label()).toBe('Roland, IAC'));
  expect(dimmed()).toBe(false);

  light().click();
  await vi.waitFor(() => expect(popover()).toBeTruthy());
  expect(popover()!.textContent).toContain('Listening to Roland, IAC');
  expect(listed()).toEqual(['Any device', 'Roland', 'IAC']);
  // Nothing pinned and nothing written is what "Any device" means, on both counts.
  expect(button('Use Any device').getAttribute('aria-pressed')).toBe('true');
  expect(button('Default Any device').getAttribute('aria-pressed')).toBe('true');

  // Use: this session only, so nothing is written.
  button('Use Roland').click();
  expect(sent()).toEqual({ pinned: '1', hidden: [] });
  expect(written).toEqual([]);
  relisted(['Roland'], '1');
  await vi.waitFor(() => expect(button('Use Roland').textContent).toBe('In use'));
  expect(button('Use Roland').getAttribute('aria-pressed')).toBe('true');
  expect(button('Use Any device').getAttribute('aria-pressed')).toBe('false');

  // Default: written, and in force at once.
  button('Default IAC').click();
  expect(written).toEqual([['midi_device', '2']]);
  expect(sent()).toEqual({ pinned: '2', hidden: [] });
  await vi.waitFor(() => expect(button('Default IAC').getAttribute('aria-pressed')).toBe('true'));
  relisted(['IAC'], '2');

  // Hide: out of the list, out of the rule, and never the default.
  button('Hide IAC').click();
  expect(sent()).toEqual({ pinned: null, hidden: ['2'] });
  await vi.waitFor(() => expect(listed()).toEqual(['Any device', 'Roland']));
  expect(disclosure().textContent).toBe('Hidden (1)');
  relisted(['Roland'], null);

  // The machine's last source hidden is a machine with no MIDI on it.
  button('Hide Roland').click();
  expect(sent()).toEqual({ pinned: null, hidden: ['2', '1'] });
  relisted([], null);
  await vi.waitFor(() => expect(label()).toBe('No MIDI device'));
  expect(dimmed()).toBe(true);
  expect(listed()).toEqual(['Any device']);

  // Show: the hidden section is closed until it is asked for.
  expect(document.querySelector('[aria-label^="Show "]')).toBe(null);
  disclosure().click();
  await vi.waitFor(() => expect(button('Show Roland')).toBeTruthy());
  button('Show Roland').click();
  expect(sent()).toEqual({ pinned: null, hidden: ['2'] });
  await vi.waitFor(() => expect(listed()).toEqual(['Any device', 'Roland']));
});

/** The "Hidden (n)" line the put-away ports sit behind. */
function disclosure(): HTMLButtonElement {
  return [...popover()!.querySelectorAll('button')].find((each) =>
    each.textContent!.startsWith('Hidden'),
  )!;
}

test('an error from Rust is what the light and the popover both say', async () => {
  emit.get('midi-ports')!({ payload: { ...connected, devices: [], error: 'CoreMIDI is down' } });
  await vi.waitFor(() =>
    expect(document.querySelector('button')!.getAttribute('aria-label')).toBe('CoreMIDI is down'),
  );
  expect(popover()!.textContent).toContain('CoreMIDI is down');
});
