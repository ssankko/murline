import { Loading } from '@/look/loading';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

let close: (() => void) | null = null;

afterEach(() => {
  close?.();
  close = null;
});

/** Mounts the indicator and hands back its marks, left to right, once each one is moving. */
async function open(): Promise<HTMLElement[]> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(Loading, { label: 'Loading the instrument' }));
  close = () => {
    root.unmount();
    host.remove();
  };
  const marks = () => [...host.querySelectorAll<HTMLElement>('[data-beat]')];
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
