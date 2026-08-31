import { BEAT_MS, ENTRANCE_MS, LogLine, usePacedLines } from '@/boot-pacing';
import { act, createElement, StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

let close: (() => void) | null = null;
let host: HTMLElement | null = null;

// `act` flushes React's work at once, so what a test reads after it is what React has drawn.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  act(() => close?.());
  close = null;
  host = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('a ref guard holds a mount effect to one run under StrictMode', async () => {
  // The guard App.tsx starts the boot behind: StrictMode mounts the effect twice, the ref lives
  // through it, so the work runs once.
  let runs = 0;
  function Once() {
    const started = useRef(false);
    useEffect(() => {
      if (started.current) return;
      started.current = true;
      runs += 1;
    }, []);
    return null;
  }
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  close = () => {
    root.unmount();
    host?.remove();
  };
  act(() => root.render(createElement(StrictMode, null, createElement(Once))));
  expect(runs).toBe(1);
});

/** The paced log, fed its lines from outside as boot's prints arrive. */
function Paced({ lines, beatMs }: { lines: string[]; beatMs: number }) {
  const { shown, drained } = usePacedLines(lines, beatMs);
  return createElement('span', null, shown.join('|') + (drained ? '!done' : ''));
}

/** Mounts the log on its lines, on fake timers, and hands back a function to feed it later prints. */
function mount(lines: string[]): (next: string[]) => void {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draw = (next: string[]) =>
    act(() => root.render(createElement(Paced, { lines: next, beatMs: BEAT_MS })));
  draw(lines);
  close = () => {
    root.unmount();
    host?.remove();
  };
  return draw;
}

/** Moves the clock on by `ms` and lets React draw whatever the beat set off. */
function elapse(ms: number) {
  act(() => vi.advanceTimersByTime(ms));
}

test('the first line is on screen at once and the rest follow a beat apart', () => {
  mount(['a', 'b', 'c']);
  expect(host!.textContent).toBe('a');
  elapse(BEAT_MS - 1);
  expect(host!.textContent).toBe('a');
  elapse(1);
  expect(host!.textContent).toBe('a|b');
  elapse(BEAT_MS);
  expect(host!.textContent).toBe('a|b|c');
  // The last line holds the screen for its own beat, so the log calls itself done a beat later.
  elapse(BEAT_MS);
  expect(host!.textContent).toBe('a|b|c!done');
});

test('a line that changes while shown updates with no new beat', () => {
  const draw = mount(['a', 'b']);
  elapse(BEAT_MS);
  elapse(BEAT_MS);
  expect(host!.textContent).toBe('a|b!done');
  draw(['a2', 'b']);
  expect(host!.textContent).toBe('a2|b!done');
});

test('a line that was not on screen before rises in; the first line does not', () => {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const draw = (enters: boolean) =>
    act(() => root.render(createElement(LogLine, { text: '> opening database … ok', enters })));
  close = () => {
    root.unmount();
    host?.remove();
  };

  draw(false);
  expect(host!.textContent).toBe('> opening database … ok');
  expect(host!.querySelector('span')!.getAnimations()).toHaveLength(0);

  draw(true);
  expect(host!.querySelector('span')!.getAnimations()).toHaveLength(1);
  const timing = host!.querySelector('span')!.getAnimations()[0]!.effect!.getTiming();
  expect(timing.duration).toBe(ENTRANCE_MS);
  expect(timing.easing).toBe('cubic-bezier(0.65, 0, 0.35, 1)');
});

test('motion turned down takes the entrance away', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(LogLine, { text: '> opening database … ok', enters: true })));
  close = () => {
    root.unmount();
    host?.remove();
  };
  expect(host!.textContent).toBe('> opening database … ok');
  expect(host!.querySelector('span')!.getAnimations()).toHaveLength(0);
});
