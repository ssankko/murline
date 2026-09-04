import { commands } from '@/bindings';
import { DEFAULT_ANSWERS, fakeFiles, fakeRust, type FakeRust } from '@/rust.fake';
import type { PieceIndex } from '@/score/summarize';
import { findsPieces, Library, nextRow } from '@/screens/library';
import { genericPart, partText } from '@/screens/piece-detail';
import { load, set } from '@/settings/settings';
import { createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

// Both read the internals only a Tauri webview carries, which the fake behind the IPC is not.
vi.mock('@/screens/use-fullscreen', () => ({ useFullscreen: () => false }));

/** The drop handler the page registers on the window, held so a test can drop files on it. */
const drop = vi.hoisted(() => ({
  handler: null as ((event: { payload: { type: string; paths: string[] } }) => void) | null,
}));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: (handler: typeof drop.handler) => {
      drop.handler = handler;
      return Promise.resolve(() => (drop.handler = null));
    },
  }),
}));

/** Reading a score is OSMD's work, which no test here is about: every dropped file indexes alike. */
vi.mock('@/library/index-file', async (original) => ({
  ...(await original<typeof import('@/library/index-file')>()),
  indexBytes: () => Promise.resolve(INDEX),
}));

/** The OS file picker Import opens, which no browser has. */
const dialog = vi.hoisted(() => ({ open: vi.fn(async (): Promise<string[] | null> => null) }));
vi.mock('@tauri-apps/plugin-dialog', () => dialog);

/** A key press as the window handler sees it, with only the parts the guard reads. */
function press(key: string, metaKey = true): KeyboardEvent {
  return { key, metaKey } as KeyboardEvent;
}

test('⌘F reaches the search field, and stands back for a dialog over the screen', () => {
  expect(findsPieces(press('f'), false)).toBe(true);
  expect(findsPieces(press('f', false), false)).toBe(false);
  expect(findsPieces(press('g'), false)).toBe(false);
  // The finder and the settings panel own every key while they stand, ⌘F with them.
  expect(findsPieces(press('f'), true)).toBe(false);
});

test('the arrows walk the shown rows and hold at both ends', () => {
  expect(nextRow(5, 0, 1)).toBe(1);
  expect(nextRow(5, 4, 1)).toBe(4);
  expect(nextRow(5, 2, -1)).toBe(1);
  expect(nextRow(5, 0, -1)).toBe(0);
  // A search that hides the selected row leaves no row to step from, so either arrow takes the first.
  expect(nextRow(5, -1, 1)).toBe(0);
  expect(nextRow(5, -1, -1)).toBe(0);
});

/** The indexing of the next folder, held open for as long as this is a promise nothing settles. */
let held: Promise<void> | null = null;
let release = () => {};

let root: Root | null = null;
let host: HTMLElement | null = null;
/** What the page asked the app to open, per test. */
let played: [string, string][] = [];
let previewed: string[] = [];

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  held = null;
  dialog.open.mockClear();
});

/** The library page under a folder the settings panel may re-point, as the app holds it. */
function Screen({ start }: { start: string | null }) {
  const [folder, setFolder] = useState(start);
  return createElement(Library, {
    folder,
    onFolder: setFolder,
    onPlay: (path: string, intent: string) => played.push([path, intent]),
    onPreview: (path: string) => previewed.push(path),
  });
}

function mount(folder: string | null): void {
  played = [];
  previewed = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(Screen, { start: folder }));
}

/** The pane the rows, the loading indicator and the empty state all land in. */
function pane(): HTMLElement {
  return document
    .querySelector('input[aria-label="Search library"]')!
    .closest('.flex-col')!
    .querySelector<HTMLElement>('.overflow-y-auto')!;
}

/** The line each row of the pane leads with, in the order they stand. */
function rows(): string[] {
  return [...pane().querySelectorAll('b')].map((line) => line.textContent!);
}

/** The row of the pane whose lines say this. */
function row(line: string): HTMLButtonElement {
  return [...pane().querySelectorAll('button')].find((one) => one.textContent!.includes(line))!;
}

/**
 * One file of a folder, with the piece row an index of it leaves behind. The reason stands in for
 * a score the fake never parses: the row is listed either way.
 */
async function piece(relPath: string, stamp: number): Promise<void> {
  fakeFiles.push({ relPath, mtime: stamp, size: stamp });
  await commands.indexMarkError(relPath, 'Not read here', stamp, stamp);
}

test('a folder still being indexed shows the loading indicator, not the rows it leaves behind', async () => {
  fakeRust({
    index_plan: async (args) => {
      await held;
      return DEFAULT_ANSWERS.index_plan(args);
    },
  });
  await load();
  await piece('old.musicxml', 1);

  mount('/old');
  await vi.waitFor(() => expect(rows()).toEqual(['old.musicxml']));

  held = new Promise((resolve) => (release = resolve));
  fakeFiles.length = 0;
  await piece('new.musicxml', 2);
  // The panel's Library tab writes the folder, and the page re-points on the write.
  await set('library_folder', '/new');

  await vi.waitFor(() =>
    expect(pane().querySelector('[role="status"]')?.textContent).toBe('Indexing /new'),
  );
  expect(rows()).toEqual([]);
  expect(pane().textContent).not.toContain('No pieces yet');

  release();
  await vi.waitFor(() => expect(rows()).toEqual(['new.musicxml']));
  expect(pane().querySelector('[role="status"]')).toBe(null);
});

const FOLDER = '/scores';
const PATH = 'bach/invention-1.musicxml';
const FULL_PATH = `${FOLDER}/${PATH}`;

/** The one piece of the detail pane's tests: two parts, and the file names the first one "P1". */
const INDEX: PieceIndex = {
  title: 'Invention No. 1',
  composer: 'J. S. Bach',
  measureCount: 22,
  durationS: 63,
  midiLo: 55,
  midiHi: 84,
  hasTempo: true,
  tempoBpm: 72,
  constantTempo: true,
  keySharps: 0,
  keyMode: 'major',
  partCount: 2,
  partName: 'P1',
};

let rust: FakeRust;

/** Mounts the page on that one piece and waits for it to reach the detail pane. */
async function opened(): Promise<void> {
  rust = fakeRust();
  await load();
  // The file and the row agree on mtime and size, so the scan finds nothing to index again.
  fakeFiles.push({ relPath: PATH, mtime: 1, size: 1 });
  await commands.indexUpsert(PATH, INDEX, 1, 1);
  mount(FOLDER);
  await vi.waitFor(() => expect(button('Practice')).toBeTruthy());
}

/** The button of the title row that says this. */
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (each) => each.textContent?.trim() === label,
  );
  expect(found).toBeTruthy();
  return found!;
}

/** Every button of the page whose words are exactly this. */
function named(label: string): HTMLButtonElement[] {
  return [...document.querySelectorAll('button')].filter(
    (each) => each.textContent?.trim() === label,
  );
}

/** A key pressed with the search field holding the focus, which is where the list's keys are read. */
async function pressInSearch(key: string): Promise<void> {
  await userEvent.click(document.querySelector('input[aria-label="Search library"]')!);
  await userEvent.keyboard(key);
}

/** The row of the open overflow menu that says this, or nothing while the menu is closed. */
function menuItem(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')].find(
    (each) => each.textContent?.trim() === label,
  );
}

test('Preview, Practice and Perform stand in the title row, and Practice is the filled one', async () => {
  await opened();
  for (const label of ['Preview', 'Practice', 'Perform']) {
    expect(button(label).closest('div')?.parentElement?.querySelector('h2')?.textContent).toBe(
      'Invention No. 1',
    );
  }
  expect(button('Practice').dataset['variant']).toBe('default');
  expect(button('Preview').dataset['variant']).toBe('outline');
  expect(button('Perform').dataset['variant']).toBe('outline');

  await userEvent.click(button('Practice'));
  await userEvent.click(button('Perform'));
  await userEvent.click(button('Preview'));
  expect(played).toEqual([
    [PATH, 'practice'],
    [PATH, 'performance'],
  ]);
  expect(previewed).toEqual([PATH]);
});

test('the star fills when it is pressed, and the row keeps its favorite mark in step', async () => {
  await opened();
  const star = (): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>('button[aria-label="Favorite"]')!;
  const mark = (): HTMLElement => document.querySelector<HTMLElement>('[data-selected] i')!;
  expect(star().getAttribute('aria-pressed')).toBe('false');
  expect(mark().className).toContain('opacity-0');

  await userEvent.click(star());
  await vi.waitFor(() => expect(star().getAttribute('aria-pressed')).toBe('true'));
  expect(rust.argsOf('piece_set_favorite')).toEqual([{ path: PATH, favorite: true }]);
  expect(mark().className).toContain('opacity-100');
});

test('a row shows a star for a favorite and its grade in words', async () => {
  rust = fakeRust();
  await load();
  fakeFiles.push({ relPath: PATH, mtime: 1, size: 1 });
  await commands.indexUpsert(PATH, INDEX, 1, 1);
  // Only a performance earns a grade, and the row says the best of them.
  await commands.performanceInsert(PATH, {
    startedAt: 1,
    seconds: 60,
    tempoMode: 'bpm',
    tempoValue: 72,
    hands: 'both',
    grade: { grade: 84 } as never,
  });
  await piece('broken.musicxml', 1);
  mount(FOLDER);
  await vi.waitFor(() => expect(rows()).toEqual(['broken.musicxml', 'Invention No. 1']));

  const read = row('Invention No. 1');
  const unread = row('broken.musicxml');
  // A piece never performed says nothing where the grade stands, and the column keeps its width.
  expect(read.textContent).toContain('best 84');
  expect(unread.textContent).not.toContain('—');
  expect(unread.textContent).not.toContain('best');
  expect(unread.querySelector('.w-16')?.textContent).toBe('');

  // The star is the favorite mark, and it stands where the eye finds it rather than at the edge.
  expect(read.querySelector('i')?.querySelector('svg')).toBeTruthy();
  expect(read.querySelector('i')!.className).toContain('opacity-0');
});

test('Delete and Reveal in Finder wait in the overflow menu, which holds the whole path', async () => {
  await opened();
  expect(menuItem('Reveal in Finder')).toBeUndefined();

  await userEvent.click(document.querySelector<HTMLButtonElement>('button[aria-label="More"]')!);
  const reveal = await vi.waitFor(() => {
    expect(menuItem('Reveal in Finder')).toBeTruthy();
    return menuItem('Reveal in Finder')!;
  });
  expect(reveal.title).toBe(FULL_PATH);
  expect(menuItem('Delete')).toBeTruthy();

  await userEvent.click(reveal);
  await vi.waitFor(() => expect(rust.argsOf('reveal_in_finder')).toEqual([{ path: FULL_PATH }]));
});

test('the meta line names the file alone, and passes over a part name the file made up', async () => {
  await opened();
  expect(document.body.textContent).toContain('invention-1.musicxml');
  expect(document.body.textContent).not.toContain(FULL_PATH);
  expect(document.body.textContent).toContain('1 of 2 parts');
  expect(document.body.textContent).not.toContain('P1');
});

test('a part name is shown when the file gives a real one', () => {
  expect(partText({ part_count: 2, part_name: 'Piano (right)' } as never)).toBe(
    'Piano (right), 1 of 2 parts',
  );
  expect(partText({ part_count: 1, part_name: 'Piano' } as never)).toBe('');
  const made = ['P1', 'Part 1', 'Instr.', 'Instr. 2', 'Instr. P1', 'MusicXML Part', 'Track 3'];
  for (const name of made) {
    expect(genericPart(name)).toBe(true);
  }
  for (const real of ['Piano', 'Violin I', 'Partita', 'Piano right hand'])
    expect(genericPart(real)).toBe(false);
});

test('the sort control says the order in force, rather than hiding it under an icon', async () => {
  await opened();
  const sort = document.querySelector('button[aria-label="Sort: Title"]')!;
  expect(sort.textContent).toBe('Title');
});

test('Enter opens the selected piece for a Practice, and a broken piece stays shut', async () => {
  rust = fakeRust();
  await load();
  fakeFiles.push({ relPath: PATH, mtime: 1, size: 1 });
  await commands.indexUpsert(PATH, INDEX, 1, 1);
  await piece('broken.musicxml', 1);
  mount(FOLDER);
  await vi.waitFor(() => expect(rows()).toEqual(['broken.musicxml', 'Invention No. 1']));

  // The broken row is the one the list opens on, and it has nothing to play.
  await userEvent.click(row('broken.musicxml'));
  await pressInSearch('{Enter}');
  expect(played).toEqual([]);

  await userEvent.click(row('Invention No. 1'));
  await pressInSearch('{Enter}');
  expect(played).toEqual([[PATH, 'practice']]);
});

test('Import and Find online stand in the title bar, and nowhere else on the page', async () => {
  await opened();
  const bar = host!.querySelector('[data-tauri-drag-region]')!;
  for (const label of ['Import', 'Find online']) {
    expect(named(label)).toHaveLength(1);
    expect(bar.contains(named(label)[0]!)).toBe(true);
  }

  await userEvent.click(button('Import'));
  expect(dialog.open).toHaveBeenCalledTimes(1);

  // "In library" answers for the whole folder, so the finder opens on every path it holds.
  await userEvent.click(button('Find online'));
  await vi.waitFor(() => expect(rust.argsOf('piece_paths')).toHaveLength(1));
});

/** Files dropped on the window, as one drop. */
function dropFiles(...paths: string[]): void {
  drop.handler!({ payload: { type: 'drop', paths } });
}

/** The name the clash prompt stands on, or nothing while no prompt stands. */
function clashName(): string | undefined {
  return document.querySelector('[role="dialog"] h2')?.textContent ?? undefined;
}

test('a second drop waits for the first, so the two clashes are asked one after the other', async () => {
  // A file of no bytes is refused before the clash check, so the dropped files carry some.
  rust = fakeRust({ read_file: () => new ArrayBuffer(8) });
  await load();
  await piece('a.musicxml', 1);
  await piece('b.musicxml', 1);
  mount(FOLDER);
  await vi.waitFor(() => expect(rows()).toEqual(['a.musicxml', 'b.musicxml']));

  // Both drops land before the first import has asked anything.
  dropFiles('/out/a.musicxml');
  dropFiles('/out/b.musicxml');

  await vi.waitFor(() => expect(clashName()).toBe('a.musicxml'));
  expect(button('Import').disabled).toBe(true);
  expect(button('Find online').disabled).toBe(true);
  // The second file has not been read, let alone copied, while the first one is being asked about.
  expect(rust.argsOf('read_file')).toEqual([{ path: '/out/a.musicxml' }]);
  expect(rust.argsOf('copy_file')).toEqual([]);

  await userEvent.click(button('Keep both'));
  await vi.waitFor(() => expect(clashName()).toBe('b.musicxml'));
  await userEvent.click(button('Keep both'));

  // Both imports finish, in the order they were dropped, under the names the folder had free.
  await vi.waitFor(() => expect(rows()).toHaveLength(4));
  expect(rust.argsOf('index_upsert').map((args) => args['path'])).toEqual([
    'a (2).musicxml',
    'b (2).musicxml',
  ]);
  expect(button('Import').disabled).toBe(false);
  expect(button('Find online').disabled).toBe(false);
});

test('neither title bar button asks anything of a library with no folder', async () => {
  fakeRust();
  await load();
  mount(null);
  await vi.waitFor(() => expect(named('Import')).toHaveLength(1));
  expect(button('Import').disabled).toBe(true);
  expect(button('Find online').disabled).toBe(true);
});
