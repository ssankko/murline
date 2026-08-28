import { Loading } from '@/look/loading';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

let close: (() => void) | null = null;
let host: HTMLElement | null = null;
/** Flips the wait the row is mounted under, as the parent waiting on something does. */
let wait: ((on: boolean) => void) | null = null;

afterEach(() => {
  close?.();
  close = null;
  host = null;
  wait = null;
});

/** Mounts the indicator on a wait and hands back its marks, left to right, once each one is moving. */
async function open(): Promise<HTMLElement[]> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  wait = (on) => root.render(createElement(Loading, { label: 'Loading the instrument', on }));
  wait(true);
  close = () => {
    root.unmount();
    host?.remove();
  };
  const marks = () => [...host!.querySelectorAll<HTMLElement>('[data-beat]')];
  await vi.waitFor(() => {
    expect(marks().filter((mark) => mark.getAnimations().length > 0)).toHaveLength(4);
  });
  return marks();
}

/** Where a mark stands and how far it has swelled, as the browser draws it this moment. */
function drawn(mark: HTMLElement): { x: number; scale: number; opacity: number } {
  const style = getComputedStyle(mark);
  const matrix = new DOMMatrixReadOnly(style.transform);
  return { x: matrix.m41, scale: matrix.m11, opacity: Number(style.opacity) };
}

test('the row is a capsule and three dots, each a step right of the one before it', async () => {
  const marks = await open();
  expect(marks.map((mark) => mark.dataset.beat)).toEqual(['strong', 'weak', 'weak', 'weak']);
  expect(document.querySelector('[role="status"]')?.textContent).toBe('Loading the instrument');
  // The capsule is taller than the dots, which is what tells the strong beat from the weak ones.
  expect(marks[0]!.getBoundingClientRect().height).toBeGreaterThan(
    marks[1]!.getBoundingClientRect().height,
  );

  // Each mark is a beat older than the one before it, so at any one moment the row stands a step
  // apart across its whole width.
  const places = marks.map((mark) => {
    const run = mark.getAnimations()[0]!;
    run.pause();
    run.currentTime = Number(run.effect!.getTiming().duration) / marks.length / 2;
    return drawn(mark).x;
  });
  expect(places).toEqual([0, 6, 12, 18]);
});

test('a mark travels the row, burns out at its end and is born again at the left', async () => {
  const marks = await open();
  const mark = marks[0]!;
  const run = mark.getAnimations()[0]!;
  run.pause();
  const beat = Number(run.effect!.getTiming().duration) / marks.length;
  expect(beat).toBe(250);
  const at = (beats: number) => {
    run.currentTime = beat * beats;
    return drawn(mark);
  };

  expect(at(0.5).x).toBe(0);
  expect(at(1.5).x).toBe(6);
  expect(at(2.5).x).toBe(12);
  expect(at(3.5).x).toBe(18);
  // The burn: the mark comes back to full ink and swells before it collapses out of the row.
  const peak = at(4 - 0.25 * 0.18);
  expect(peak.opacity).toBeCloseTo(1, 2);
  expect(peak.scale).toBeCloseTo(1.3, 2);
  const gone = at(3.999);
  expect(gone.opacity).toBeLessThan(0.2);
  expect(gone.scale).toBeLessThan(0.3);
  // The loop runs on: the same mark is back at the left of the row a beat later.
  expect(at(4.5)).toMatchObject({ x: 0, opacity: 0.55 });
});

test('a wait that ends leaves the row running to the next beat, then out to the right', async () => {
  const marks = await open();
  wait!(false);
  // The row does not blink out where the wait ended: it is still on the page, still beating.
  expect(host!.querySelector('[role="status"]')).not.toBeNull();
  expect(marks[0]!.getAnimations()[0]!.playState).toBe('running');

  // On the next beat the beat itself gives way to one short exit.
  await vi.waitFor(
    () => {
      const exit = marks[0]!.getAnimations()[0];
      expect(Number(exit?.effect?.getTiming().duration)).toBe(200);
    },
    { interval: 10, timeout: 2000 },
  );
  const xOf = (frame: ComputedKeyframe) => new DOMMatrixReadOnly(String(frame.transform)).m41;
  for (const mark of marks) {
    const exit = mark.getAnimations()[0]!.effect as KeyframeEffect;
    const [from, to] = exit.getKeyframes();
    expect(xOf(to!)).toBeGreaterThan(xOf(from!));
    expect(Number(to!.opacity)).toBe(0);
  }

  // Once the exit is over there is nothing of the row left on the page.
  await vi.waitFor(() => expect(host!.querySelector('[role="status"]')).toBeNull(), {
    interval: 10,
    timeout: 2000,
  });
});

test('a row mounted on no wait at all draws nothing', async () => {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(Loading, { label: 'Loading the instrument', on: false }));
  close = () => {
    root.unmount();
    host?.remove();
  };
  await vi.waitFor(() => expect(host!.querySelector('[data-beat]')).toBeNull());
  expect(host!.textContent).toBe('');
});
