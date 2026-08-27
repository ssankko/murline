import { SettingsPanel, type SettingChange } from '@/screens/settings';
import { userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {},
  invoke: async (command: string) => {
    if (command === 'pdmx_status') return false;
    throw new Error(`unexpected command ${command}`);
  },
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
});

/** Mounts an open panel and waits for the settings read to land its rows on the page. */
async function open(): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(SettingsPanel, { open: true, onClose: () => {} }));
  await vi.waitFor(() => expect(host!.querySelector('#setting-row-click_volume')).toBeTruthy());
}

/** Types into the search box and returns the results, each a button naming one row. */
async function search(text: string): Promise<HTMLButtonElement[]> {
  const box = host!.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;
  await userEvent.fill(box, text);
  return [...host!.querySelectorAll<HTMLButtonElement>('ul button')];
}

function labels(results: HTMLButtonElement[]): string[] {
  return results.map((result) => result.querySelector('span')!.textContent!);
}

/** The tab whose trigger is active, by its label. */
function activeTab(): string {
  return host!.querySelector('[role="tab"][data-state="active"]')!.textContent!;
}

async function openTab(label: string): Promise<void> {
  const trigger = [...host!.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (each) => each.textContent === label,
  )!;
  await userEvent.click(trigger);
}

function marked(id: string): boolean {
  return host!.querySelector(`#setting-row-${id}`)?.getAttribute('data-marked') === 'true';
}

test('a word from a row label finds it and jumps to its tab', async () => {
  await open();
  expect(labels(await search('volume'))).toContain('Click volume');

  // The panel opens on Sound, so the jump has to be seen coming back from another tab.
  await openTab('Library');
  expect(activeTab()).toBe('Library');

  const results = await search('volume');
  await userEvent.click(results.find((each) => each.textContent!.startsWith('Click volume'))!);

  expect(activeTab()).toBe('Sound');
  expect(marked('click_volume')).toBe(true);
});

test('a word no label holds still finds the rows it names', async () => {
  await open();

  // "Storage" is what CONTEXT.md tells the app not to call the library folder, so it is exactly
  // what a player types. No row label holds it, so only the synonyms can match.
  const results = await search('storage');
  expect(labels(results)).toEqual(['Library folder', 'PDMX folder']);

  await userEvent.click(results[0]!);
  expect(activeTab()).toBe('Library');
  expect(marked('library_folder')).toBe(true);
});

test('a tab name finds every row on that tab', async () => {
  await open();
  expect(labels(await search('playing'))).toContain('Velocity offset');
});

test('a word for the harmony display finds the sheet row and the falling-notes row', async () => {
  await open();

  // "Chords" is what CONTEXT.md tells the app not to call the harmony display. The two views each
  // switch their own, so the same label stands under two headings and the heading tells them apart.
  const results = await search('chords');
  expect(labels(results)).toEqual(['Harmony', 'Harmony']);
  expect(results.map((each) => each.textContent)).toEqual([
    'HarmonyLook · Sheet',
    'HarmonyLook · Falling notes',
  ]);

  await userEvent.click(results[1]!);
  expect(activeTab()).toBe('Look');
  expect(marked('lane_harmony')).toBe(true);
  expect(marked('sheet_harmony')).toBe(false);
});

test('a pinch behind the panel moves the row it belongs to', async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const show = (live?: SettingChange) =>
    root!.render(createElement(SettingsPanel, { open: true, onClose: () => {}, live }));
  show();
  await vi.waitFor(() => expect(host!.querySelector('#setting-row-click_volume')).toBeTruthy());
  await openTab('Look');

  const slider = (label: string) =>
    host!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const spacing = () => slider('Sheet spacing in percent').value;
  const lookahead = () => slider('Lane lookahead in beats').value;
  expect(spacing()).not.toBe('200');

  // Every step of a pinch on the sheet arrives as one of these, so the slider drags with it.
  show(['sheet_spacing', 140]);
  await vi.waitFor(() => expect(spacing()).toBe('140'));
  show(['sheet_spacing', 200]);
  await vi.waitFor(() => expect(spacing()).toBe('200'));

  // A pinch on the lane moves the other slider, and leaves the sheet's where the fingers left it.
  show(['lane_lookahead', 4.3]);
  await vi.waitFor(() => expect(lookahead()).toBe('4.3'));
  expect(spacing()).toBe('200');
});

test('the search names no row the panel does not render', async () => {
  await open();
  const queries = ['volume', 'storage', 'playing', 'window', 'midi', 'download', 'grade'];
  for (const query of queries.concat('chords', 'theme', 'pinch', 'labels')) {
    const found = labels(await search(query));
    expect(found.length, query).toBeGreaterThan(0);
    for (const label of found) {
      const results = await search(query);
      await userEvent.click(results.find((each) => each.textContent!.startsWith(label))!);
      expect(host!.textContent, `${query} → ${label}`).toContain(label);
    }
  }
});

test('a shut panel is off the page and out of reach', async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(SettingsPanel, { open: false, onClose: () => {} }));
  await vi.waitFor(() => expect(host!.querySelector('[role="dialog"]')).toBeTruthy());

  const panel = host.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(panel.dataset.state).toBe('closed');
  expect(panel.inert).toBe(true);
  expect(panel.className).toContain('translate-x-full');
});
