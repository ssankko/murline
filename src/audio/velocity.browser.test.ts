import { curveOf, curved, positionOf } from '@/audio/curve';
import type { Sounding } from '@/audio/sounding';
import { VelocitySection } from '@/audio/velocity';
import { fakeRust, type FakeRust } from '@/rust.fake';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vitest/browser';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let rust: FakeRust;

let stored: Record<string, number> = { velocity_min: 1, velocity_max: 127, velocity_curve: 1 };
let written: [string, unknown][] = [];

vi.mock('@/db/db', () => ({
  readSettings: async () => stored,
  setSetting: async (key: string, value: unknown) => {
    written.push([key, value]);
  },
}));

let close: (() => void) | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  rust = fakeRust();
  written = [];
  stored = { velocity_min: 1, velocity_max: 127, velocity_curve: 1 };
});

afterEach(() => {
  close?.();
  close = null;
  host = null;
});

/** A key struck at that velocity and still down, which is all this plot reads of one. */
function key(midi: number, velocity: number): Sounding {
  return { midi, velocity, on: true, at: performance.now(), held: 0 };
}

async function open(sounding: Sounding[] = []): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(VelocitySection, { sounding }));
  close = () => {
    root.unmount();
    host?.remove();
  };
  await vi.waitFor(() => expect(slider('Velocity curve').disabled).toBe(false));
}

function slider(label: string): HTMLInputElement {
  return host!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

function move(label: string, to: string): Promise<void> {
  return userEvent.fill(slider(label), to);
}

function dot(): SVGCircleElement | null {
  return host!.querySelector('circle');
}

function dots(): SVGCircleElement[] {
  return [...host!.querySelectorAll('circle')];
}

test('the mapping is the one the engine applies', () => {
  // Both ends are exact wherever they are put, and the exponent bends the path between them.
  expect(curved(1, 1, 127, 1.6)).toBe(1);
  expect(curved(1, 64, 127, 1.6)).toBe(64);
  expect(curved(127, 64, 127, 1.6)).toBe(127);
  expect(curved(0, 64, 127, 1.6)).toBe(0);

  // Nothing is clamped: the whole input range is squeezed into the band, not cut off at it.
  expect(curved(127, 1, 40, 1)).toBe(40);
  expect(curved(64, 1, 40, 1)).toBe(21);

  expect(curved(64, 1, 127, 1)).toBe(64);
  expect(curved(64, 1, 127, 2)).toBeLessThan(64);
  expect(curved(64, 1, 127, 0.5)).toBeGreaterThan(64);
});

test('the middle of the curve slider is the straight line', () => {
  expect(curveOf(50)).toBe(1);
  expect(curveOf(0)).toBeGreaterThan(1);
  expect(curveOf(100)).toBeLessThan(1);
  expect(positionOf(1)).toBe(50);
  expect(positionOf(curveOf(20))).toBe(20);
});

test('every slider reaches the running engine as it moves, with nothing to apply', async () => {
  await open();

  await move('Minimum velocity', '40');
  expect(written).toContainEqual(['velocity_min', 40]);
  expect(rust.argsOf('audio_set_velocity_curve')).toContainEqual({ min: 40, max: 127, curve: 1 });

  await move('Maximum velocity', '90');
  expect(written).toContainEqual(['velocity_max', 90]);
  expect(rust.argsOf('audio_set_velocity_curve')).toContainEqual({ min: 40, max: 90, curve: 1 });

  // The curve carries the two ends that were just set, so one slider never undoes another.
  await move('Velocity curve', '20');
  expect(written).toContainEqual(['velocity_curve', curveOf(20)]);
  expect(rust.argsOf('audio_set_velocity_curve')).toContainEqual({
    min: 40,
    max: 90,
    curve: curveOf(20),
  });
});

test('the minimum cannot be dragged past the maximum, nor the maximum under it', async () => {
  await open();

  await move('Maximum velocity', '60');
  await move('Minimum velocity', '100');
  expect(written).toContainEqual(['velocity_min', 60]);
  expect(slider('Minimum velocity').value).toBe('60');

  await move('Maximum velocity', '20');
  expect(written).toContainEqual(['velocity_max', 60]);
  expect(slider('Maximum velocity').value).toBe('60');
});

test('the plot marks every key under the hands, each in its own colour', async () => {
  await open([key(60, 40), key(64, 80), key(67, 110)]);
  expect(dots().map((one) => one.getAttribute('data-strike'))).toEqual(['40', '80', '110']);
  // Three pitches, three colours, so a chord can be told apart on the plot.
  expect(new Set(dots().map((one) => one.getAttribute('fill'))).size).toBe(3);
});

test('the plot marks a strike and follows the sliders', async () => {
  await open();
  expect(dot()).toBeNull();

  // The strike arrives already remapped, so its height on the plot is the output velocity itself.
  close?.();
  await open([key(60, 64)]);
  const struck = dot()!;
  expect(struck.getAttribute('data-strike')).toBe('64');
  const height = struck.getAttribute('cy');

  // Raising the minimum squeezes the band upward, so the input behind that same output was a
  // lighter press than it was: the dot slides left along the curve and keeps its height.
  const right = Number(struck.getAttribute('cx'));
  await move('Minimum velocity', '40');
  await vi.waitFor(() => expect(Number(dot()!.getAttribute('cx'))).toBeLessThan(right));
  expect(dot()!.getAttribute('cy')).toBe(height);
});
