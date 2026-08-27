import { PreviewScreen } from '@/screens/preview';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// The fixture is served as a URL, the closest a browser test gets to the bytes Rust would read.
const FIXTURES = import.meta.glob('../score/fixtures/*', {
  query: '?url',
  import: 'default',
  eager: true,
});
const FILE = 'test_repeat_volta_simple.musicxml';

let status = { available: true, reason: '' };
let sent: { command: string; args: Record<string, unknown> }[] = [];
/** The progress handler the screen subscribed with, so a test can be the engine. */
let progress: ((event: { payload: { seconds: number; playing: boolean } }) => void) | null = null;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: Record<string, unknown> = {}) => {
    sent.push({ command, args });
    if (command === 'audio_status') return status;
    if (command === 'read_file') {
      const url = FIXTURES[`../score/fixtures/${FILE}`] as string;
      return await (await fetch(url)).arrayBuffer();
    }
    if (command.startsWith('preview_')) return undefined;
    throw new Error(`unexpected command ${command}`);
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    if (name === 'preview-progress') progress = handler as typeof progress;
    return () => {};
  },
}));

vi.mock('@/library/scan', () => ({ reindexIfChanged: async () => {} }));
vi.mock('@/library/queries', () => ({ getPiece: async () => null }));

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  status = { available: true, reason: '' };
  sent = [];
  progress = null;
});

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
});

/** Mounts the Preview and waits for the sheet to be on the paper. */
async function open(): Promise<void> {
  host = document.createElement('div');
  host.style.cssText = 'width:800px;height:600px';
  document.body.append(host);
  root = createRoot(host);
  root.render(
    createElement(PreviewScreen, {
      folder: '/scores',
      path: FILE,
      onBack: () => {},
      onPlay: () => {},
    }),
  );
  // Every button in the header carries an SVG icon; the drawn sheet is the one OSMD names.
  await vi.waitFor(() => expect(host!.querySelectorAll('#osmdCanvasPage1').length).toBe(1), {
    timeout: 30_000,
  });
}

function commands(): string[] {
  return sent.filter((call) => call.command.startsWith('preview_')).map((call) => call.command);
}

function button(label: string): HTMLButtonElement {
  return host!.querySelector(`button[aria-label="${label}"]`)!;
}

/** Where the bar highlight stands, or null while nothing is highlighted. */
function tint(): string | null {
  const el = host!.querySelector<HTMLElement>('.preview-bar');
  if (!el || el.style.display === 'none') return null;
  return `${el.style.left} ${el.style.top} ${el.style.width}`;
}

test('play hands the engine the note list and starts it', async () => {
  await open();

  button('Play').click();
  await vi.waitFor(() => expect(commands()).toContain('preview_play'));

  expect(commands()).toEqual(['preview_load', 'preview_rate', 'preview_play']);
  const notes = sent.find((call) => call.command === 'preview_load')!.args.notes as {
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

test('a click seeks to the bar the progress event then puts the highlight back on', async () => {
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
  const seconds = sent.find((call) => call.command === 'preview_seek')!.args.seconds as number;
  expect(seconds).toBeGreaterThan(0);
  const clicked = tint();
  expect(clicked).not.toBeNull();

  // The engine reports the start of the piece, then the time the click sought to: the highlight
  // leaves the clicked bar and comes back to it.
  progress!({ payload: { seconds: 0, playing: true } });
  expect(tint()).not.toBe(clicked);

  progress!({ payload: { seconds, playing: true } });
  expect(tint()).toBe(clicked);
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
  status = { available: false, reason: 'No instrument chosen' };
  await open();

  await vi.waitFor(() => expect(button('Play').disabled).toBe(true));
  expect(button('Slower').disabled).toBe(true);
  expect(button('Faster').disabled).toBe(true);
  expect(button('Play').closest('[title]')?.getAttribute('title')).toBe('No instrument chosen');

  button('Play').click();
  expect(commands()).toEqual([]);
}, 60_000);
