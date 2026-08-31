import { RolesSection } from '@/audio/roles';
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
  // The load put the levels on, so showing them asks the engine for nothing.
  expect(asked()).toEqual([]);
});

test('moving a role keeps its level and sends it to the engine', async () => {
  await keep({ 'other.exs': { release: 0 } });
  show(ALL);
  await vi.waitFor(() => expect(slider('Key-off noise')).toBeTruthy());

  await userEvent.fill(slider('Key-off noise')!, '40');
  await vi.waitFor(() =>
    expect(rust.written()).toContainEqual([
      'instrument_roles',
      { 'other.exs': { release: 0 }, 'grand.exs': { key_off: 40 } },
    ]),
  );
  expect(put().at(-1)).toEqual(['key_off', 40]);
  expect(slider('Key-off noise')!.value).toBe('40');
});

test('the sliders show the levels the instrument was left at, sent by nobody', async () => {
  await keep({ 'grand.exs': { sympathetic: 0, pedal_noise: 25 } });
  show(ALL);
  await vi.waitFor(() => expect(slider('Pedal noise')?.value).toBe('25'));
  expect(slider('Sympathetic resonance')!.value).toBe('0');
  expect(slider('Release samples')!.value).toBe('100');
  // The load is what put them on the engine, so the section asks it for nothing.
  expect(asked()).toEqual([]);
});

test('a set of roles switched off reads as those roles at 0', async () => {
  await keep({ 'grand.exs': ['sympathetic', 'pedal_noise'] });
  show(ALL);
  await vi.waitFor(() => expect(slider('Sympathetic resonance')?.value).toBe('0'));
  expect(slider('Pedal noise')!.value).toBe('0');
  expect(slider('Key-off noise')!.value).toBe('100');
});
