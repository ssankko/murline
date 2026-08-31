import { NO_STATUS, type Role } from '@/rust';
import { fakeRust, fakeSettings } from '@/rust.fake';
import { SettingsPanel } from '@/screens/settings';
import { load } from '@/settings/settings';
import { userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/** Set by the PDMX test so the archive is still coming while it looks at the row. */
let fetching: { promise: Promise<void>; release: () => void } | null = null;

/** What the engine says the instrument offers: a sampled piano, until a test says otherwise. */
const OFFERED: Role[] = ['release', 'key_off', 'sympathetic', 'pedal_noise'];
let roles = [...OFFERED];

beforeEach(async () => {
  fakeRust({
    pdmx_fetch: async () => {
      await fetching?.promise;
    },
    // `roles` is what the loaded instrument offers beyond its tone, which is what puts the four
    // level rows on the Sound tab.
    audio_status: () => ({ ...NO_STATUS, available: true, roles }),
    // A file instrument with an envelope, which is what puts the four envelope rows on the tab.
    audio_envelope: () => ({ attack: 0.01, decay: 0.5, sustain: 0.8, release: 0.4 }),
    audio_output_devices: () => [],
    audio_instruments: () => [],
  });
  await load();
});

// The app's stylesheet is Tailwind's and is not built for a test, so the column is given here the
// height and the scroll its classes carry in the app.
document.head.append(
  Object.assign(document.createElement('style'), {
    textContent: '[role="dialog"] .overflow-y-auto.px-4 { height: 220px; overflow-y: auto; }',
  }),
);

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  roles = [...OFFERED];
  vi.restoreAllMocks();
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
  expect(labels(results)).toEqual(['Keyboard', 'Metronome']);
  expect(wheres(results)).toEqual(['Volume', 'Volume']);

  expect(labels(await search('metronome'))).toEqual(['Metronome']);

  // A word the panel's own rows hold still points at the tab they are on, not at the mixer.
  const touch = await search('touch');
  expect(labels(touch)).toEqual(['Minimum velocity', 'Maximum velocity', 'Velocity curve']);
  expect(wheres(touch)).toEqual(['Sound · Touch', 'Sound · Touch', 'Sound · Touch']);
});

test('a result naming an input device shuts the panel and opens the MIDI popover', async () => {
  let midi = 0;
  let closed = 0;
  await open({ onOpenMidi: () => midi++, onClose: () => closed++ });

  const results = await search('midi');
  expect(labels(results)).toEqual(['Input device']);
  expect(wheres(results)).toEqual(['MIDI']);
  await userEvent.click(results[0]!);

  expect(midi).toBe(1);
  expect(closed).toBe(1);
  // The devices are chosen in the popover, so the Playing tab has nothing to show for them.
  await openTab('Playing');
  expect(document.querySelector('#setting-row-midi_device')).toBe(null);
  expect(document.body.textContent).not.toContain('Input device');
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
  expect(labels(results)).toEqual(['Library folder']);

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
  expect(labels(await search('playing'))).toContain('Matching window');
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
    // A popover's control opens the popover instead, which the tests above cover; every other
    // result has to be on the page once it is clicked.
    const popovers = ['Volume', 'MIDI'];
    const rows = labels(found).filter((_, at) => !popovers.includes(wheres(found)[at]!));
    for (const label of rows) {
      const results = await search(query);
      await userEvent.click(results.find((each) => each.textContent!.startsWith(label))!);
      expect(document.body.textContent, `${query} → ${label}`).toContain(label);
    }
  }
});

// The three screens hold the component whether it is open or not, so a shut panel is a mounted
// component with nothing on the page. Radix portals the modal, so ask the whole page, not the host.
test('an instrument offering no roles keeps the role rows out of the search', async () => {
  roles = [];
  await open();

  const found = labels(await search('release'));
  expect(found).not.toContain('Release samples');
  // The envelope's own Release row is not a role row, so it is still found.
  expect(found).toContain('Release');
});

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

/** The choice a row shows as pressed, by its label. */
function pressed(id: string): string {
  return [...document.querySelectorAll<HTMLButtonElement>(`#setting-row-${id} button`)].find(
    (each) => each.getAttribute('aria-pressed') === 'true',
  )!.textContent!;
}

function slider(id: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`#setting-row-${id} input[type="range"]`)!;
}

test('down marks the first row of the open tab and up holds at the top', async () => {
  await open();
  expect(marked('audio_output_device')).toBe(false);

  await userEvent.keyboard('{ArrowDown}');
  await vi.waitFor(() => expect(marked('audio_output_device')).toBe(true));

  await userEvent.keyboard('{ArrowDown}');
  await vi.waitFor(() => expect(marked('audio_buffer_frames')).toBe(true));

  // Two Ups from the second row stop at the first rather than running off the top.
  await userEvent.keyboard('{ArrowUp}{ArrowUp}');
  await vi.waitFor(() => expect(marked('audio_output_device')).toBe(true));
});

test('space steps the marked row s choice and left and right move its slider', async () => {
  await open();
  await search('theme');
  await userEvent.keyboard('{Enter}');
  await vi.waitFor(() => expect(marked('theme')).toBe(true));
  expect(activeTab()).toBe('Look');

  // Three choices, so Space steps to the next one rather than flipping.
  expect(pressed('theme')).toBe('System');
  await userEvent.keyboard(' ');
  await vi.waitFor(() => expect(pressed('theme')).toBe('Light'));

  // The next row down is a two-button toggle, which the same key flips.
  await userEvent.keyboard('{ArrowDown}');
  await vi.waitFor(() => expect(marked('sheet_proportional')).toBe(true));
  expect(pressed('sheet_proportional')).toBe('Off');
  await userEvent.keyboard(' ');
  await vi.waitFor(() => expect(pressed('sheet_proportional')).toBe('On'));

  // 80 to 300 in steps of 5: a twentieth of the span is 11, which rounds to two steps.
  await userEvent.keyboard('{ArrowDown}');
  await vi.waitFor(() => expect(marked('sheet_spacing')).toBe(true));
  expect(slider('sheet_spacing').value).toBe('150');
  await userEvent.keyboard('{ArrowRight}');
  await vi.waitFor(() => expect(slider('sheet_spacing').value).toBe('160'));
  await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
  await vi.waitFor(() => expect(slider('sheet_spacing').value).toBe('165'));
  await userEvent.keyboard('{ArrowLeft}');
  await vi.waitFor(() => expect(slider('sheet_spacing').value).toBe('155'));
});

test('a control worked by the mouse marks its row, and the keys carry on from there', async () => {
  await open();
  await openTab('Look');
  expect(marked('sheet_harmony')).toBe(false);

  await userEvent.click(
    [...document.querySelectorAll<HTMLButtonElement>('#setting-row-sheet_harmony button')].find(
      (each) => each.textContent === 'Off',
    )!,
  );
  await vi.waitFor(() => expect(marked('sheet_harmony')).toBe(true));

  await userEvent.keyboard('{ArrowDown}');
  await vi.waitFor(() => expect(marked('sheet_colour')).toBe(true));
});

test('an envelope row moves one step whether shift is held or not', async () => {
  await open();
  await search('attack');
  await userEvent.keyboard('{Enter}');
  await vi.waitFor(() => expect(marked('envelope_attack')).toBe(true));

  // 0 to 2000 ms: a twentieth would be 100, and the envelope is set a millisecond at a time.
  expect(slider('envelope_attack').value).toBe('10');
  await userEvent.keyboard('{ArrowRight}');
  await vi.waitFor(() => expect(slider('envelope_attack').value).toBe('11'));
  await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
  await vi.waitFor(() => expect(slider('envelope_attack').value).toBe('9'));
});

test('a query nothing matches says so', async () => {
  await open();
  expect(await search('bassoon')).toEqual([]);
  expect(document.querySelector('ul')!.textContent).toContain('Nothing matches');
});

test('the PDMX row beats while the archive is coming', async () => {
  let release = (): void => {};
  fetching = { promise: new Promise<void>((done) => (release = done)), release: () => release() };
  await open();
  await openTab('Library');

  const beating = () => document.querySelector('#setting-row-pdmx_scores [role="status"]');
  expect(beating()).toBe(null);
  await userEvent.click(
    [...document.querySelectorAll<HTMLElement>('button')].find(
      (each) => each.textContent === 'Download (1.9 GB)',
    )!,
  );

  await vi.waitFor(() => expect(beating()).not.toBe(null));
  fetching.release();
  await vi.waitFor(() => expect(beating()).toBe(null));
  fetching = null;
});

/** What inside the panel the browser holds as keyboard-focused. */
function ringed(): string[] {
  return [...document.querySelectorAll('[role="dialog"] *')]
    .filter((each) => each.matches(':focus-visible'))
    .map((each) => each.getAttribute('aria-label') ?? each.tagName);
}

/** Marks a row the way a search result does, which is how the walk starts anywhere but the top. */
async function jump(query: string, id: string): Promise<void> {
  await search(query);
  await userEvent.keyboard('{Enter}');
  await vi.waitFor(() => expect(marked(id)).toBe(true));
}

// Radix gives each tab panel a tabindex, so a click anywhere in the body focuses the panel itself
// and the next key turns that focus visible: a ring around every row at once.
test('walking the panel draws no ring around the rows', async () => {
  await open();

  await userEvent.keyboard('{ArrowDown}');
  await vi.waitFor(() => expect(marked('audio_output_device')).toBe(true));
  expect(document.activeElement).toBe(
    document.querySelector('input[aria-label="Search settings"]'),
  );
  expect(ringed()).toEqual(['Search settings']);

  // The same walk after a click in the body, which is what used to focus the tab panel.
  await userEvent.click(document.querySelector('#setting-row-audio_buffer_frames > span')!);
  expect(document.querySelector('[role="tabpanel"]')!.hasAttribute('tabindex')).toBe(false);
  await userEvent.keyboard('{ArrowDown}');
  await vi.waitFor(() => expect(marked('audio_buffer_frames')).toBe(true));
  expect(ringed()).toEqual([]);
  // A click with no control under it leaves focus on the modal, which draws no ring of its own.
  expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'));
  expect((document.activeElement as HTMLElement).className).toContain('outline-none');
});

test('every number setting is a slider the arrows move', async () => {
  await open();

  // 1 to 1000 in whole milliseconds: a twentieth of the span is 50.
  await jump('matching window', 'matching_window_ms');
  expect(slider('matching_window_ms').value).toBe('150');
  await userEvent.keyboard('{ArrowRight}');
  await vi.waitFor(() => expect(slider('matching_window_ms').value).toBe('200'));

  await userEvent.keyboard('{ArrowDown}');
  await vi.waitFor(() => expect(marked('togetherness_ms')).toBe(true));
  expect(slider('togetherness_ms')).toBeTruthy();

  await openTab('Look');
  expect(slider('lane_note_width')).toBeTruthy();
  expect(slider('lane_gap')).toBeTruthy();
});

test('a grade knob is a slider of its own, found by search and stepped by the arrows', async () => {
  await open();

  const results = await search('Timing weight');
  expect(labels(results)).toEqual(['Timing weight']);
  await userEvent.click(results[0]!);
  await vi.waitFor(() => expect(marked('grade_weight_timing')).toBe(true));
  expect(activeTab()).toBe('Playing');

  // 0 to 1 in hundredths, and the readout says the value rather than a float with a long tail.
  expect(slider('grade_weight_timing').step).toBe('0.01');
  const readout = () =>
    [...document.querySelectorAll('#setting-row-grade_weight_timing span')].pop()!.textContent!;
  expect(readout()).toBe('0.7');

  await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
  await vi.waitFor(() => expect(readout()).toBe('0.71'));

  // The fold above the knobs holds them all, and moves none of them.
  await userEvent.keyboard('{ArrowUp}');
  await vi.waitFor(() => expect(marked('grade_weight_timing')).toBe(false));
  await userEvent.keyboard('{ArrowRight}');
  expect(readout()).toBe('0.71');
});

// What the mixer's "Sound settings…" does: the panel opens with one row named, and the column is
// scrolled to it.
test('a panel opened at a row scrolls to it', async () => {
  const scrolled: string[] = [];
  vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
    scrolled.push(this.id);
  });

  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(
    createElement(SettingsPanel, { open: true, onClose: () => {}, jumpTo: 'instrument_id' }),
  );

  await vi.waitFor(() => expect(marked('instrument_id')).toBe(true));
  await vi.waitFor(() => expect(scrolled).toContain('setting-row-instrument_id'));
});

test('the footer names the keys of the state the panel is in', async () => {
  await open();
  const footer = () => document.querySelector('footer')!.textContent!;
  // With no results up the keys are the marked row's, and Enter does nothing.
  expect(footer()).toContain('space change');
  expect(footer()).not.toContain('↩ open');

  await search('theme');
  expect(footer()).toContain('↩ open');
  expect(footer()).not.toContain('space change');
  expect(footer()).toContain('esc close');
});

/** Whether every button of a row is dead. */
function dead(id: string): boolean {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(`#setting-row-${id} button`)];
  return buttons.length > 0 && buttons.every((each) => each.disabled);
}

test('the two inactive-hand rows are dead while the hand does not sound', async () => {
  await open();
  await openTab('Playing');

  expect(dead('play_inactive_hand_velocity')).toBe(true);
  expect(slider('play_inactive_hand_level').disabled).toBe(true);

  const sounds = document.querySelectorAll<HTMLButtonElement>(
    '#setting-row-play_inactive_hand button',
  );
  await userEvent.click([...sounds].find((each) => each.textContent === 'On')!);

  await vi.waitFor(() => expect(dead('play_inactive_hand_velocity')).toBe(false));
  expect(slider('play_inactive_hand_level').disabled).toBe(false);
});

test('a reopened panel carries no results over from the last one', async () => {
  await open();
  expect(await search('chords')).toHaveLength(2);

  root!.render(createElement(SettingsPanel, { open: false, onClose: () => {} }));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBe(null));

  root!.render(createElement(SettingsPanel, { open: true, onClose: () => {} }));
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeTruthy());
  expect(document.querySelector('[role="dialog"] ul')).toBe(null);
  const box = document.querySelector<HTMLInputElement>('input[aria-label="Search settings"]')!;
  expect(box.value).toBe('');
});

// The panel opens where it was left: a real column that scrolls, and a settings table that keeps
// what is written to it, so a second mount after a fresh read is the next launch.

/** What one setting is stored as, or undefined for one never written. */
function stored(key: string): unknown {
  return fakeSettings.get(key);
}

/** The scrolling column, which is what holds the open tab's rows. */
function column(): HTMLElement {
  return document.querySelector('[role="tabpanel"]')!.parentElement!;
}

/** Mounts an open panel and waits for the rows of whatever tab it opens on. */
async function openAnyTab(props: Record<string, unknown> = {}): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(SettingsPanel, { open: true, onClose: () => {}, ...props }));
  await vi.waitFor(() => expect(document.querySelector('[role="tabpanel"]')).toBeTruthy());
}

/** Shuts the app down: the panel goes, the settings stay. */
function quit(): void {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
}

/** The next launch: the panel is gone and the settings are read again. */
async function relaunch(): Promise<void> {
  quit();
  await load();
  await openAnyTab();
}

test('the panel opens on the tab and the place it was left', async () => {
  await open();
  expect(activeTab()).toBe('Sound');

  await openTab('Look');
  const box = column();
  const room = box.scrollHeight - box.clientHeight;
  expect(room, 'the Look tab is longer than the panel is tall').toBeGreaterThan(40);
  const offset = Math.round(room / 2);
  box.scrollTop = offset;

  // The write rests behind the scrolling, so the value lands about 300 ms after the last move.
  await vi.waitFor(() => expect(stored('settings_scroll')).toBe(offset));
  expect(stored('settings_tab')).toBe('look');

  await relaunch();
  await vi.waitFor(() => expect(activeTab()).toBe('Look'));
  await vi.waitFor(() => expect(column().scrollTop).toBe(offset));
});

test('another tab opens at the top', async () => {
  await open();
  await openTab('Look');
  const box = column();
  box.scrollTop = box.scrollHeight - box.clientHeight;
  await vi.waitFor(() => expect(stored('settings_scroll')).toBeGreaterThan(0));

  await openTab('Playing');
  expect(column().scrollTop).toBe(0);
  expect(stored('settings_scroll')).toBe(0);
  expect(stored('settings_tab')).toBe('playing');
});

test('a row to open on wins over the place the panel was left', async () => {
  fakeSettings.set('settings_tab', 'look');
  fakeSettings.set('settings_scroll', 120);
  await load();

  await openAnyTab({ jumpTo: 'library_folder' });
  await vi.waitFor(() => expect(activeTab()).toBe('Library'));
  expect(marked('library_folder')).toBe(true);
});

// The write rests 300 ms behind the scrolling and a tab switch writes 0 at once, so what is left
// stored has to be the new tab's top rather than the old tab's offset.
test('a scroll write still resting when the tab changes never lands', async () => {
  await open();
  await openTab('Look');
  const box = column();
  box.scrollTop = box.scrollHeight - box.clientHeight;
  await new Promise((done) => setTimeout(done, 100));

  await openTab('Playing');
  await new Promise((done) => setTimeout(done, 500));
  expect(stored('settings_scroll')).toBe(0);
  expect(column().scrollTop).toBe(0);
});
