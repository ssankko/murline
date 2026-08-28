import { RolesSection, restoreRoles, type Role } from '@/audio/roles';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { userEvent } from 'vitest/browser';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/** Every role a Logic piano offers beyond its tone. */
const ALL: Role[] = ['release', 'key_off', 'sympathetic', 'pedal_noise'];

let sent: [string, unknown][] = [];
/** What the engine answers `audio_status` with, for the roles it names there. */
let offered: Role[] = ALL;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    sent.push([command, args]);
    if (command === 'audio_status') return { roles: offered };
    if (command === 'audio_set_roles') return null;
    throw new Error(`unexpected command ${command}`);
  },
}));

let kept: Record<string, Role[]> = {};
let written: [string, unknown][] = [];

vi.mock('@/db/db', () => ({
  getSettingOr: async () => kept,
  setSetting: async (key: string, value: unknown) => {
    written.push([key, value]);
  },
}));

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  sent = [];
  written = [];
  kept = {};
  offered = ALL;
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

function show(roles: Role[], round = 0): void {
  if (!host) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  }
  root!.render(createElement(RolesSection, { roles, instrument: 'grand.exs', round }));
}

function toggle(label: string): HTMLButtonElement | null {
  return host!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

function put(): [string, unknown][] {
  return sent.filter(([command]) => command === 'audio_set_roles');
}

test('an instrument with no roles to offer has no section', async () => {
  show([]);
  await vi.waitFor(() => expect(host!.textContent).toBe(''));
  expect(sent).toHaveLength(0);
});

test('every role the instrument offers gets a toggle, all on by default', async () => {
  show(ALL);
  await vi.waitFor(() => expect(toggle('Pedal noise')).toBeTruthy());
  for (const label of [
    'Release samples',
    'Key-off noise',
    'Sympathetic resonance',
    'Pedal noise',
  ]) {
    expect(toggle(label)?.getAttribute('aria-pressed'), label).toBe('true');
  }
});

test('switching a role off keeps it and leaves the engine playing the others', async () => {
  kept = { 'other.exs': ['release'] };
  show(ALL);
  await vi.waitFor(() => expect(toggle('Key-off noise')).toBeTruthy());

  await userEvent.click(toggle('Key-off noise')!);
  await vi.waitFor(() =>
    expect(written).toContainEqual([
      'instrument_roles',
      { 'other.exs': ['release'], 'grand.exs': ['key_off'] },
    ]),
  );
  expect(put().at(-1)).toEqual([
    'audio_set_roles',
    { roles: ['release', 'sympathetic', 'pedal_noise'] },
  ]);
  expect(toggle('Key-off noise')!.getAttribute('aria-pressed')).toBe('false');
});

test('the set the instrument was left on goes back in after a load', async () => {
  kept = { 'grand.exs': ['sympathetic', 'pedal_noise'] };
  show(ALL);
  await vi.waitFor(() =>
    expect(put()).toContainEqual(['audio_set_roles', { roles: ['release', 'key_off'] }]),
  );
  expect(toggle('Sympathetic resonance')!.getAttribute('aria-pressed')).toBe('false');

  // The same instrument loaded again: the engine has forgotten the set, so it is sent once more.
  show(ALL, 1);
  await vi.waitFor(() => expect(put()).toHaveLength(2));
  expect(put()[1]).toEqual(['audio_set_roles', { roles: ['release', 'key_off'] }]);
});

test('boot asks the engine what the instrument offers and takes the kept roles out of it', async () => {
  kept = { 'grand.exs': ['pedal_noise'] };
  await restoreRoles('grand.exs');
  expect(put()).toEqual([
    ['audio_set_roles', { roles: ['release', 'key_off', 'sympathetic'] }],
  ]);
});

test('an instrument with nothing switched off is left as the load left it', async () => {
  await restoreRoles('grand.exs');
  await restoreRoles(null);
  expect(sent).toHaveLength(0);
});
