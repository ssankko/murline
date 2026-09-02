import { Finder } from '@/screens/finder';
import type { FinderRow } from '@/bindings';
import { fakeRust, refusal } from '@/rust.fake';
import { createElement } from 'react';
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

beforeEach(() => {
  held = null;
  reason = null;
  fakeRust({
    pdmx_status: () => true,
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
});

/** Opens the finder on one search hit, selected, with its Download button on the page. */
async function open(): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(
    createElement(Finder, {
      folder: '/library',
      libraryPaths: new Set<string>(),
      onImported: async () => {},
      close: () => {},
    }),
  );
  close = () => {
    root.unmount();
    host.remove();
  };
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

/** What the download button says it is doing, if anything. */
function beating(): boolean {
  return document.querySelector('[data-slot="dialog-content"] [role="status"]') !== null;
}

test('the Download button beats while the score is coming, and stops when it fails', async () => {
  let release = (): void => {};
  held = { promise: new Promise<void>((resolve) => (release = resolve)), release: () => release() };
  reason = 'KernScores is not answering';

  const button = await open();
  expect(beating()).toBe(false);
  await userEvent.click(button);

  await vi.waitFor(() => expect(beating()).toBe(true));
  expect(document.body.textContent).toContain('Downloading…');

  held.release();
  await vi.waitFor(() => expect(document.body.textContent).toContain('KernScores is not answering'));
  await vi.waitFor(() => expect(beating()).toBe(false));
});
