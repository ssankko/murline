import { Finder } from '@/screens/finder';
import type { FinderRow } from '@/bindings';
import { setNotice, useNotice } from '@/library/notice';
import { fakeRust, refusal, type FakeRust } from '@/rust.fake';
import { createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

const ROW: FinderRow = {
  provider: 'KernScores',
  heading: 'Chopin, Frédéric',
  title: 'Prelude',
  opus: '28',
  number: '4',
  movement: null,
  movementName: null,
  key: 'e minor',
  time: '4/4',
  bars: 25,
  ratings: 0,
  alt: null,
  file: 'chopin/prelude28-4.krn',
  fileName: 'prelude28-4.musicxml',
};

/** Set by a test that wants the download to stand still until it releases it. */
let held: { promise: Promise<void>; release: () => void } | null = null;
let reason: string | null = null;

vi.mock('@/library/import', () => ({
  importFiles: async () => ({ imported: ['prelude28-4.musicxml'], failures: [] }),
}));

let close: (() => void) | null = null;
let dropNotice: (() => void) | null = null;
let rust: FakeRust;

/**
 * The library's notice slot, standing outside the finder as it does in the library page, so the
 * message a closed finder leaves behind can be read.
 */
function Notice() {
  const [text] = useNotice();
  return createElement('p', { id: 'notice' }, text);
}

/** What the notice slot holds. */
function notice(): string {
  return document.querySelector('#notice')?.textContent ?? '';
}

beforeEach(() => {
  held = null;
  reason = null;
  setNotice(null);
  dropNotice = mount(createElement(Notice));
  rust = fakeRust({
    pdmx_status: () => ({ ready: true, running: false, done: 0, total: null, error: null }),
    finder_search: () => ({ rows: [ROW], more: 0 }),
    finder_download: async () => {
      if (held) await held.promise;
      if (reason) throw refusal('refused', reason);
      return '/tmp/prelude28-4.musicxml';
    },
  });
});

afterEach(() => {
  close?.();
  close = null;
  dropNotice?.();
  dropNotice = null;
});

/** Puts one element on the page and answers with the way to take it off again. */
function mount(element: ReactElement): () => void {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(element);
  return () => {
    root.unmount();
    host.remove();
  };
}

/** Opens the finder on one search hit, selected, with its Download button on the page. */
async function open(
  onImported: (path: string) => Promise<void> = async () => {},
): Promise<HTMLElement> {
  close = mount(
    createElement(Finder, {
      folder: '/library',
      libraryPaths: new Set<string>(),
      onImported,
      close: () => {},
    }),
  );
  const box = await vi.waitFor(() => {
    const found = document.querySelector<HTMLInputElement>('input[aria-label="Composer or title"]');
    expect(found).toBeTruthy();
    return found!;
  });
  await userEvent.fill(box, 'chopin');
  return await vi.waitFor(() => {
    const button = [...document.querySelectorAll<HTMLElement>('button')].find((each) =>
      each.textContent?.includes('Download'),
    );
    expect(button).toBeTruthy();
    return button!;
  });
}

/** Holds the download until the test releases it. */
function hold(): void {
  let release = (): void => {};
  held = { promise: new Promise<void>((resolve) => (release = resolve)), release: () => release() };
}

/** What the download button says it is doing, if anything. */
function beating(): boolean {
  return document.querySelector('[data-slot="dialog-content"] [role="status"]') !== null;
}

test('the Download button beats and reads Cancel while the score is coming, and stops when it fails', async () => {
  hold();
  reason = 'KernScores is not answering';

  const button = await open();
  expect(beating()).toBe(false);
  await userEvent.click(button);

  await vi.waitFor(() => expect(beating()).toBe(true));
  expect(button.textContent).toContain('Cancel');

  held!.release();
  await vi.waitFor(() => expect(document.body.textContent).toContain('KernScores is not answering'));
  await vi.waitFor(() => expect(beating()).toBe(false));
  expect(button.textContent).toBe('Download');
});

test('Cancel returns the button to Download, and the score that lands after it changes nothing', async () => {
  hold();
  const imported: string[] = [];
  const button = await open(async (path) => {
    imported.push(path);
  });

  await userEvent.click(button);
  await vi.waitFor(() => expect(button.textContent).toContain('Cancel'));
  await userEvent.click(button);
  await vi.waitFor(() => expect(beating()).toBe(false));
  expect(button.textContent).toBe('Download');

  // The download arrives all the same: its temp file goes and nothing else moves.
  held!.release();
  await vi.waitFor(() =>
    expect(rust.argsOf('remove_temp_file')).toEqual([{ path: '/tmp/prelude28-4.musicxml' }]),
  );
  expect(imported).toEqual([]);
  expect(document.body.textContent).not.toContain('Could not download');
});

test('a download that fails after the finder closed leaves its reason as a library notice', async () => {
  hold();
  reason = 'KernScores is not answering';

  const button = await open();
  await userEvent.click(button);
  await vi.waitFor(() => expect(button.textContent).toContain('Cancel'));

  // Escape closes the finder over the running download.
  close!();
  close = null;
  held!.release();
  await vi.waitFor(() =>
    expect(notice()).toBe('Could not download from KernScores: KernScores is not answering.'),
  );
});
