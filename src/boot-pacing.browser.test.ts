import { BEAT_MS, ENTRANCE_MS, LogLine, usePacedLines } from '@/boot-pacing';
import { createElement, StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

let close: (() => void) | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  close?.();
  close = null;
  host = null;
  vi.unstubAllGlobals();
});

/** The paced log, fed its lines from outside as boot's prints arrive. */
function Paced({ lines, beatMs }: { lines: string[]; beatMs: number }) {
  const { shown, drained } = usePacedLines(lines, beatMs);
  return createElement('span', null, shown.join('|') + (drained ? '!done' : ''));
}

/** Mounts the log on its lines and hands back a function to feed it later prints. */
function mount(lines: string[], beatMs = 20, strict = false): (next: string[]) => void {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draw = (next: string[]) => {
    const paced = createElement(Paced, { lines: next, beatMs });
    // The first render flushes synchronously, so the log stands on the page the moment mount
    // returns, as the real boot screen does in its first paint.
    flushSync(() =>
      root.render(strict ? createElement(StrictMode, null, paced) : paced),
    );
  };
  draw(lines);
  close = () => {
    root.unmount();
    host?.remove();
  };
  return draw;
}

test('the first line is on screen at once and the rest follow a beat apart', async () => {
  mount(['a', 'b', 'c']);
  expect(host!.textContent).toBe('a');
  // Every commit is on record, so the states the log passed through are asserted in order rather
  // than raced against a poll.
  const seen = [host!.textContent];
  const observer = new MutationObserver(() => {
    const now = host!.textContent ?? '';
    if (seen[seen.length - 1] !== now) seen.push(now);
  });
  observer.observe(host!, { childList: true, subtree: true, characterData: true });
  await vi.waitFor(() => expect(host!.textContent).toBe('a|b|c!done'), { timeout: 500 });
  observer.disconnect();
  expect(seen).toEqual(['a', 'a|b', 'a|b|c!done']);
});

test('a line that changes while shown updates with no new beat', async () => {
  const draw = mount(['a', 'b']);
  await vi.waitFor(() => expect(host!.textContent).toBe('a|b!done'), { timeout: 500 });
  draw(['a2', 'b']);
  await vi.waitFor(() => expect(host!.textContent).toBe('a2|b!done'), { timeout: BEAT_MS });
});

test('two boot runs interleaved leave one paced log', async () => {
  const draw = mount(['a'], 20, true);
  draw(['a', 'b']);
  draw(['a', 'b', 'c']);
  await vi.waitFor(() => expect(host!.textContent).toBe('a|b|c!done'), { timeout: 1000 });
});

test('a line that was not on screen before rises in; the first line does not', async () => {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draw = (enters: boolean) =>
    root.render(createElement(LogLine, { text: '> opening database … ok', enters }));
  close = () => {
    root.unmount();
    host?.remove();
  };

  draw(false);
  await vi.waitFor(() => expect(host!.textContent).toBe('> opening database … ok'));
  expect(host!.querySelector('span')!.getAnimations()).toHaveLength(0);

  draw(true);
  await vi.waitFor(() => expect(host!.querySelector('span')!.getAnimations()).toHaveLength(1));
  const timing = host!.querySelector('span')!.getAnimations()[0]!.effect!.getTiming();
  expect(timing.duration).toBe(ENTRANCE_MS);
  expect(timing.easing).toBe('cubic-bezier(0.65, 0, 0.35, 1)');
});

test('motion turned down takes the entrance away', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(LogLine, { text: '> opening database … ok', enters: true }));
  close = () => {
    root.unmount();
    host?.remove();
  };
  await vi.waitFor(() => expect(host!.textContent).toBe('> opening database … ok'));
  expect(host!.querySelector('span')!.getAnimations()).toHaveLength(0);
});
