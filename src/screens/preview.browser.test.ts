import { NO_STATUS, type AudioStatus } from '@/rust';
import { fakeRust, type FakeRust } from '@/rust.fake';
import { PreviewScreen } from '@/screens/preview';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

// The fixture is served as a URL, the closest a browser test gets to the bytes Rust would read.
const FIXTURES = import.meta.glob('../score/fixtures/*', {
  query: '?url',
  import: 'default',
  eager: true,
});
const FILE = 'test_repeat_volta_simple.musicxml';

let status: AudioStatus = { ...NO_STATUS, available: true };
let rust: FakeRust;

// The window is fullscreen only inside Tauri, so the test drives the top bar's hook itself.
let setFullscreen: ((full: boolean) => void) | null = null;

vi.mock('@/screens/use-fullscreen', async () => {
  const { useState } = await import('react');
  return {
    useFullscreen: () => {
      const [full, set] = useState(false);
      setFullscreen = set;
      return full;
    },
  };
});

/** Every row the screen writes: the piece's tempo, and the settings the panel changes. */
let written: { sql: string; values: unknown[] }[] = [];

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: async () => ({
      select: async () => [],
      execute: async (sql: string, values: unknown[]) => void written.push({ sql, values }),
    }),
  },
}));

vi.mock('@/library/scan', () => ({ reindexIfChanged: async () => {} }));
// Only the one call is stubbed: the settings panel pulls the module's constants in behind it.
vi.mock('@/library/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/library/queries')>()),
  getPiece: async () => null,
}));

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  status = { ...NO_STATUS, available: true };
  written = [];
  setFullscreen = null;
  rust = fakeRust({
    audio_status: () => status,
    read_file: async () => {
      const url = FIXTURES[`../score/fixtures/${FILE}`] as string;
      return await (await fetch(url)).arrayBuffer();
    },
    // The settings panel comes up with the screen and asks the engine what it has.
    audio_envelope: () => null,
  });
});

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
});

/** Mounts the Preview and waits for the sheet to be on the paper. */
async function open(onBack: () => void = () => {}): Promise<void> {
  host = document.createElement('div');
  host.style.cssText = 'width:800px;height:600px';
  document.body.append(host);
  root = createRoot(host);
  root.render(
    createElement(PreviewScreen, {
      folder: '/scores',
      path: FILE,
      onBack,
      onPlay: () => {},
    }),
  );
  // Every button in the header carries an SVG icon; the drawn sheet is the one OSMD names.
  await vi.waitFor(() => expect(host!.querySelectorAll('#osmdCanvasPage1').length).toBe(1), {
    timeout: 30_000,
  });
}

function commands(): string[] {
  return rust.calls.map((one) => one.name).filter((name) => name.startsWith('preview_'));
}

function button(label: string): HTMLButtonElement {
  return host!.querySelector(`button[aria-label="${label}"]`)!;
}

/** A key the screen's own handler reads: nothing on the page has the focus in a test. */
function press(key: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key }));
}

/** The panel is a portal, so its own controls are found by their text on the whole page. */
async function waitForEl(selector: string, text: string): Promise<HTMLElement> {
  return vi.waitFor(() => {
    const el = [...document.querySelectorAll<HTMLElement>(selector)].find(
      (each) => each.textContent === text,
    );
    expect(el).toBeTruthy();
    return el!;
  });
}

/** Where the cursor band stands on the page: its x along the system, and the system's top. */
function band(): { x: number; top: number } {
  const el = host!.querySelector<HTMLElement>('.sheet-cursor')!;
  return {
    x: parseFloat(el.style.transform.slice('translateX('.length)),
    top: parseFloat(el.style.top),
  };
}

test('play hands the engine the note list and starts it', async () => {
  await open();

  button('Play').click();
  await vi.waitFor(() => expect(commands()).toContain('preview_play'));

  expect(commands()).toEqual(['preview_load', 'preview_rate', 'preview_play']);
  const notes = rust.argsOf('preview_load')[0]!.notes as {
    midi: number;
    on: number;
    off: number;
    velocity: number;
  }[];
  expect(notes.length).toBeGreaterThan(0);
  expect(notes[0]!.off).toBeGreaterThan(notes[0]!.on);
  expect(notes.every((note) => note.midi > 0 && note.velocity > 0)).toBe(true);

  // Pause and play again: the piece is loaded once and the second play resumes it.
  button('Pause').click();
  await vi.waitFor(() => expect(commands()).toContain('preview_pause'));
  button('Play').click();
  await vi.waitFor(() => expect(commands().filter((c) => c === 'preview_play').length).toBe(2));
  expect(commands().filter((c) => c === 'preview_load').length).toBe(1);
}, 60_000);

test('a click seeks to the Onset the progress event then puts the band back on', async () => {
  await open();

  const heads = [...host!.querySelectorAll('#osmdCanvasPage1 .vf-stavenote')];
  const head = heads[heads.length - 1]!;
  const box = head.getBoundingClientRect();
  head.dispatchEvent(
    new MouseEvent('click', {
      bubbles: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    }),
  );

  await vi.waitFor(() => expect(commands()).toContain('preview_seek'));
  const seconds = rust.argsOf('preview_seek')[0]!.seconds;
  expect(seconds).toBeGreaterThan(0);
  const clicked = band();

  // The engine reports the start of the piece, then the time the click sought to: the band leaves
  // the clicked Onset on the next frame and comes back to it on the frame after.
  rust.emit('preview-progress', { seconds: 0, playing: false });
  await vi.waitFor(() => expect(band().x).not.toBeCloseTo(clicked.x, 0));

  rust.emit('preview-progress', { seconds, playing: false });
  await vi.waitFor(() => expect(band().x).toBeCloseTo(clicked.x, 0));
  expect(band().top).toBe(clicked.top);
}, 60_000);

test('leaving the screen stops the engine', async () => {
  await open();
  button('Play').click();
  await vi.waitFor(() => expect(commands()).toContain('preview_play'));

  root!.unmount();
  root = null;

  expect(commands()).toContain('preview_stop');
}, 60_000);

test('with no engine the transport is dead and says why', async () => {
  status = { ...NO_STATUS, reason: 'No instrument chosen' };
  await open();

  await vi.waitFor(() => expect(button('Play').getAttribute('aria-disabled')).toBe('true'));
  expect(button('Slower').getAttribute('aria-disabled')).toBe('true');
  expect(button('Faster').getAttribute('aria-disabled')).toBe('true');
  expect(button('Play').closest('[title]')?.getAttribute('title')).toBe('No instrument chosen');

  button('Play').click();
  expect(commands()).toEqual([]);
}, 60_000);

test('Space plays and pauses', async () => {
  await open();

  press(' ');
  await vi.waitFor(() => expect(commands()).toContain('preview_play'));

  press(' ');
  await vi.waitFor(() => expect(commands()).toContain('preview_pause'));
}, 60_000);

test('Escape rewinds off the start of the piece and leaves from it', async () => {
  let backs = 0;
  await open(() => backs++);

  button('Play').click();
  await vi.waitFor(() => expect(button('Pause')).toBeTruthy());

  press('Escape');
  await vi.waitFor(() => expect(commands()).toContain('preview_stop'));
  expect(backs).toBe(0);

  // Back at the start, the same key is the way out.
  await vi.waitFor(() => expect(button('Play')).toBeTruthy());
  press('Escape');
  expect(backs).toBe(1);
}, 60_000);

test('fullscreen folds the traffic-light gap down to the bar\'s own padding', async () => {
  await open();

  const bar = () => host!.querySelector<HTMLElement>('[data-tauri-drag-region]')!;
  expect(bar().className).toContain('pl-20');

  setFullscreen!(true);
  await vi.waitFor(() => expect(bar().className).not.toContain('pl-20'));
  expect(bar().className).toMatch(/\bpl-2\b/);
}, 60_000);

test('the tempo stepper writes the piece row and reads back on the bar', async () => {
  await open();

  button('Faster').click();
  await vi.waitFor(() => expect(written.some((row) => row.sql.includes('tempo_value'))).toBe(true));

  expect(written.find((row) => row.sql.includes('tempo_value'))!.values).toEqual([FILE, 105]);
  expect(button('Tempo').textContent).toBe('105 %');
}, 60_000);

test('a Look change in the panel reaches the page without reopening it', async () => {
  await open();
  const bubbles = () => host!.querySelectorAll('.chord-bubble').length;
  expect(bubbles()).toBeGreaterThan(0);

  button('Settings').click();
  await userEvent.click(await waitForEl('[role="tab"][data-state]', 'Look'));
  await userEvent.click(await waitForEl('#setting-row-sheet_harmony button', 'Off'));

  await vi.waitFor(() => expect(bubbles()).toBe(0));
}, 60_000);
