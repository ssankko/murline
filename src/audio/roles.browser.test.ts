import { RolesSection, restoreRoles } from '@/audio/roles';
import { NO_STATUS, type Role } from '@/rust';
import { fakeRust, fakeSettings, type FakeRust } from '@/rust.fake';
import { load } from '@/settings/settings';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { userEvent } from 'vitest/browser';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/** Every role a Logic piano offers beyond its tone. */
const ALL: Role[] = ['release', 'key_off', 'sympathetic', 'pedal_noise'];

let rust: FakeRust;
/** What the engine answers `audio_status` with, for the roles it names there. */
let offered: Role[] = ALL;

/** Puts the levels every instrument is kept at where a launch would find them. */
async function keep(all: Record<string, Partial<Record<Role, number>> | Role[]>): Promise<void> {
  fakeSettings.set('instrument_roles', all);
  await load();
}

/** Every setting written so far, in the shape the store sent it. */
function written(): [string, unknown][] {
  return rust.argsOf('settings_write').map(({ key, value }) => [key, value]);
}

/** What the engine was asked, the settings aside. */
function asked(): string[] {
  return rust.calls.map(({ name }) => name).filter((name) => !name.startsWith('settings_'));
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
  offered = ALL;
  rust = fakeRust({ audio_status: () => ({ ...NO_STATUS, roles: offered }) });
  await load();
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

function slider(label: string): HTMLInputElement | null {
  return host!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
}

/** The levels the engine was given, role by role, in the order they were sent. */
function put(): [Role, number][] {
  return rust.argsOf('audio_apply_role_level').map(({ role, percent }) => [role, percent]);
}

test('an instrument with no roles to offer has no section', async () => {
  show([]);
  await vi.waitFor(() => expect(host!.textContent).toBe(''));
  expect(asked()).toEqual([]);
});

test('every role the instrument offers gets a slider, all at 100 by default', async () => {
  show(ALL);
  await vi.waitFor(() => expect(slider('Pedal noise')).toBeTruthy());
  for (const label of [
    'Release samples',
    'Key-off noise',
    'Sympathetic resonance',
    'Pedal noise',
  ]) {
    expect(slider(label)?.value, label).toBe('100');
  }
  expect(host!.querySelector('#setting-row-role_key_off')).toBeTruthy();
  await vi.waitFor(() => expect(put()).toHaveLength(4));
});

test('moving a role keeps its level and sends it to the engine', async () => {
  await keep({ 'other.exs': { release: 0 } });
  show(ALL);
  await vi.waitFor(() => expect(slider('Key-off noise')).toBeTruthy());

  await userEvent.fill(slider('Key-off noise')!, '40');
  await vi.waitFor(() =>
    expect(written()).toContainEqual([
      'instrument_roles',
      { 'other.exs': { release: 0 }, 'grand.exs': { key_off: 40 } },
    ]),
  );
  expect(put().at(-1)).toEqual(['key_off', 40]);
  expect(slider('Key-off noise')!.value).toBe('40');
});

test('the levels the instrument was left at go back in after a load', async () => {
  await keep({ 'grand.exs': { sympathetic: 0, pedal_noise: 25 } });
  show(ALL);
  await vi.waitFor(() =>
    expect(put()).toEqual([
      ['release', 100],
      ['key_off', 100],
      ['sympathetic', 0],
      ['pedal_noise', 25],
    ]),
  );
  expect(slider('Pedal noise')!.value).toBe('25');

  // The same instrument loaded again: the engine has put every role back to 100, so the levels
  // are sent once more.
  show(ALL, 1);
  await vi.waitFor(() => expect(put()).toHaveLength(8));
});

test('boot asks the engine what the instrument offers and sends the kept levels', async () => {
  await keep({ 'grand.exs': { pedal_noise: 0 } });
  await restoreRoles('grand.exs');
  expect(put()).toEqual([
    ['release', 100],
    ['key_off', 100],
    ['sympathetic', 100],
    ['pedal_noise', 0],
  ]);
});

test('a set of roles switched off reads as those roles at 0', async () => {
  await keep({ 'grand.exs': ['sympathetic', 'pedal_noise'] });
  await restoreRoles('grand.exs');
  expect(put()).toEqual([
    ['release', 100],
    ['key_off', 100],
    ['sympathetic', 0],
    ['pedal_noise', 0],
  ]);
});

test('an instrument with nothing moved is left as the load left it', async () => {
  await restoreRoles('grand.exs');
  await restoreRoles(null);
  expect(asked()).toEqual([]);
});
