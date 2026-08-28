import { SettingsPanel, type SettingChange } from '@/screens/settings';
import { userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {},
  invoke: async (command: string) => {
    if (command === 'pdmx_status') return false;
    // The Sound tab asks the engine about itself the moment it is on the page.
    if (command === 'audio_status') return { available: true, reason: '', fallback: '' };
    if (command === 'audio_output_devices') return [];
    if (command === 'audio_instruments') return [];
    if (command === 'audio_effects') return [];
    if (command === 'audio_set_chain') return [];
    throw new Error(`unexpected command ${command}`);
  },
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

// Clicking a control writes it, so the panel needs a database that swallows the write.
vi.mock('@tauri-apps/plugin-sql', () => ({
  default: { load: async () => ({ select: async () => [], execute: async () => {} }) },
}));

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
});

/** Mounts an open panel and waits for the settings read to land its rows on the page. */
async function open(props: Record<string, unknown> = {}): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(SettingsPanel, { open: true, onClose: () => {}, ...props }));
  await vi.waitFor(() => expect(document.querySelector('#setting-row-instrument_id')).toBeTruthy());
}

/** Types into the search box and returns the results, each a button naming one row. */
async function search(text: string): Promise<HTMLButtonElement[]> {
  const box = document.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;
  await userEvent.fill(box, text);
  return [...document.querySelectorAll<HTMLButtonElement>('ul button')];
}

function labels(results: HTMLButtonElement[]): string[] {
  return results.map((result) => result.querySelector('span')!.textContent!);
}

/** Where each result says its row lives: a tab's name, or the mixer's. */
function wheres(results: HTMLButtonElement[]): string[] {
  return results.map((result) => result.querySelectorAll('span')[1]!.textContent!);
}

/** The tab whose trigger is active, by its label. */
function activeTab(): string {
  return document.querySelector('[role="tab"][data-state="active"]')!.textContent!;
}

async function openTab(label: string): Promise<void> {
  const trigger = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (each) => each.textContent === label,
  )!;
  await userEvent.click(trigger);
}

function marked(id: string): boolean {
  return document.querySelector(`#setting-row-${id}`)?.getAttribute('data-marked') === 'true';
}

test('a word from a row label finds it and jumps to its tab', async () => {
  await open();
  expect(labels(await search('buffer'))).toContain('Buffer (frames)');

  // The panel opens on Sound, so the jump has to be seen coming back from another tab.
  await openTab('Library');
  expect(activeTab()).toBe('Library');

  const results = await search('buffer');
  await userEvent.click(results.find((each) => each.textContent!.startsWith('Buffer'))!);

  expect(activeTab()).toBe('Sound');
  expect(marked('audio_buffer_frames')).toBe(true);
});

// The two faders are the mixer's, so the index names them and sends the player to the mixer. The
// rule is that a result never names something the player cannot reach; it does not say that
// everything reachable has to be a row in the panel.
test('a volume is found whether it is a row here or a fader in the mixer', async () => {
  await open();
  const results = await search('volume');
  expect(labels(results)).toEqual(['Keyboard', 'Metronome', 'Softest note volume']);
  expect(wheres(results)).toEqual(['Volume', 'Volume', 'Sound']);

  expect(labels(await search('metronome'))).toEqual(['Metronome']);
});

test('a result naming a fader shuts the panel and opens the mixer', async () => {
  let mixer = 0;
  let closed = 0;
  await open({ onOpenMixer: () => mixer++, onClose: () => closed++ });

  const results = await search('metronome');
  await userEvent.click(results[0]!);

  expect(mixer).toBe(1);
  expect(closed).toBe(1);
  // The panel stayed where it was rather than switching to a tab that does not hold the fader.
  expect(activeTab()).toBe('Sound');
});

test('a panel opened at a row lands on that row s tab with it marked', async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  // What the mixer's way into the Sound tab does, from a panel that would otherwise open on Sound
  // with nothing marked.
  root.render(
    createElement(SettingsPanel, { open: true, onClose: () => {}, jumpTo: 'library_folder' }),
  );
  await vi.waitFor(() => expect(activeTab()).toBe('Library'));
  expect(marked('library_folder')).toBe(true);
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

test('the sound engine rows are found and jumped to like any other', async () => {
  await open();

  // "Reverb" is a plugin a player would go looking for, and no row label holds it.
  const results = await search('reverb');
  expect(labels(results)).toEqual(['Effect chain']);

  await openTab('Library');
  const again = await search('reverb');
  await userEvent.click(again[0]!);
  expect(activeTab()).toBe('Sound');
  expect(marked('effect_chain')).toBe(true);
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

test('keyboard size is one row on Look, and the custom range appears only when it is chosen', async () => {
  await open();

  // One global row, so choosing 88 once holds for every piece. It used to be three piece columns.
  const results = await search('88');
  expect(labels(results)).toEqual(['Keyboard size']);
  await userEvent.click(results[0]!);
  expect(activeTab()).toBe('Look');
  expect(marked('keyboard_size')).toBe(true);

  const preset = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (each) => each.textContent === label,
    )!;
  expect(document.querySelector('select[aria-label="Lowest key"]')).toBe(null);
  await userEvent.click(preset('Custom'));
  await vi.waitFor(() =>
    expect(document.querySelector('select[aria-label="Lowest key"]')).toBeTruthy(),
  );
  await userEvent.click(preset('88'));
  await vi.waitFor(() =>
    expect(document.querySelector('select[aria-label="Lowest key"]')).toBe(null),
  );
});

test('a pinch behind the panel moves the row it belongs to', async () => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const show = (live?: SettingChange) =>
    root!.render(createElement(SettingsPanel, { open: true, onClose: () => {}, live }));
  show();
  await vi.waitFor(() => expect(document.querySelector('#setting-row-instrument_id')).toBeTruthy());
  await openTab('Look');

  const slider = (label: string) =>
    document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
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
  for (const query of [
    'storage',
    'playing',
    'window',
    'midi',
    'download',
    'grade',
    'sound',
    'reverb',
    'latency',
    'preset',
    'sf2',
    'headphones',
    'chords',
    'theme',
    'pinch',
    'labels',
    'keys',
    '88',
    'touch',
    'dynamics',
  ]) {
    const found = await search(query);
    expect(found.length, query).toBeGreaterThan(0);
    // A fader is the mixer's and opens it instead, which the test above covers; every other result
    // has to be on the page once it is clicked.
    const rows = labels(found).filter((_, at) => wheres(found)[at] !== 'Volume');
    for (const label of rows) {
      const results = await search(query);
      await userEvent.click(results.find((each) => each.textContent!.startsWith(label))!);
      expect(document.body.textContent, `${query} → ${label}`).toContain(label);
    }
  }
});

// The three screens hold the component whether it is open or not, so a shut panel is a mounted
// component with nothing on the page. Radix portals the modal, so ask the whole page, not the host.
test('a shut panel is off the page and out of reach', async () => {
  await open();
  expect(document.querySelector('[role="dialog"]')).toBeTruthy();

  root!.render(createElement(SettingsPanel, { open: false, onClose: () => {} }));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBe(null));
  expect(document.querySelector('input[aria-label="Search settings"]')).toBe(null);
  expect(document.querySelector('[data-slot="dialog-overlay"]')).toBe(null);
});

test('an open panel is a modal the play screen s keys stand back for', async () => {
  await open();
  // What `play.tsx` and `preview.tsx` look for before letting Space or Escape reach the clock.
  const panel = document.querySelector<HTMLElement>('[role="dialog"][data-state="open"]')!;
  expect(panel).toBeTruthy();
  expect(panel.className).toContain('top-[12%]');
  expect(panel.className).toContain('w-[640px]');
  // Lighter than the finder's overlay, so the sheet behind stays readable.
  expect(document.querySelector('[data-slot="dialog-overlay"]')!.className).toContain(
    'bg-black/20',
  );
});

test('escape closes the modal', async () => {
  let closed = 0;
  await open({ onClose: () => closed++ });
  await userEvent.keyboard('{Escape}');
  await vi.waitFor(() => expect(closed).toBe(1));
});

test('the arrows move the search selection and enter picks it', async () => {
  await open();
  await openTab('Library');

  const results = await search('chords');
  expect(labels(results)).toEqual(['Harmony', 'Harmony']);
  expect(results[0]!.dataset.selected).toBe('true');

  await userEvent.keyboard('{ArrowDown}');
  await vi.waitFor(() => {
    const now = [...document.querySelectorAll<HTMLButtonElement>('ul button')];
    expect(now[1]!.dataset.selected).toBe('true');
    expect(now[0]!.dataset.selected).toBe(undefined);
  });

  // Up never runs off the top, so a second press holds the first row.
  await userEvent.keyboard('{ArrowUp}{ArrowUp}');
  await vi.waitFor(() =>
    expect(document.querySelectorAll<HTMLButtonElement>('ul button')[0]!.dataset.selected).toBe(
      'true',
    ),
  );

  await userEvent.keyboard('{ArrowDown}{Enter}');
  await vi.waitFor(() => expect(activeTab()).toBe('Look'));
  expect(marked('lane_harmony')).toBe(true);
  expect(marked('sheet_harmony')).toBe(false);
});

test('a query nothing matches says so', async () => {
  await open();
  expect(await search('bassoon')).toEqual([]);
  expect(document.querySelector('ul')!.textContent).toContain('Nothing matches');
});
