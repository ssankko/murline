import { curveOf, curved, positionOf } from '@/audio/curve';
import { VelocitySection } from '@/audio/velocity';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vitest/browser';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

let sent: [string, unknown][] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    sent.push([command, args]);
    if (command === 'audio_set_velocity_curve') return null;
    throw new Error(`unexpected command ${command}`);
  },
}));

let stored: Record<string, number> = { velocity_floor: 0, velocity_curve: 1.6 };
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
  sent = [];
  written = [];
  stored = { velocity_floor: 0, velocity_curve: 1.6 };
});

afterEach(() => {
  close?.();
  close = null;
  host = null;
});

async function open(velocity: number | null = null): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(VelocitySection, { velocity }));
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

test('the mapping is the one the engine applies', () => {
  // The two ends are fixed wherever the softest note is put, and the exponent bends the path.
  expect(curved(1, 0, 1.6)).toBe(1);
  expect(curved(1, 50, 1.6)).toBe(64);
  expect(curved(127, 50, 1.6)).toBe(127);
  expect(curved(0, 50, 1.6)).toBe(0);

  expect(curved(64, 0, 1)).toBe(64);
  expect(curved(64, 0, 2)).toBeLessThan(64);
  expect(curved(64, 0, 0.5)).toBeGreaterThan(64);
});

test('the middle of the curve slider is the straight line', () => {
  expect(curveOf(50)).toBe(1);
  expect(curveOf(0)).toBeGreaterThan(1);
  expect(curveOf(100)).toBeLessThan(1);
  expect(positionOf(1)).toBe(50);
  expect(positionOf(curveOf(20))).toBe(20);
});

test('either slider reaches the running engine as it moves, with nothing to apply', async () => {
  await open();

  await move('Softest note volume', '40');
  expect(written).toContainEqual(['velocity_floor', 40]);
  expect(sent).toContainEqual(['audio_set_velocity_curve', { floor: 40, curve: 1.6 }]);

  // The curve carries the floor that was just set, so one slider never undoes the other.
  await move('Velocity curve', '50');
  expect(written).toContainEqual(['velocity_curve', 1]);
  expect(sent).toContainEqual(['audio_set_velocity_curve', { floor: 40, curve: 1 }]);
});

test('the plot marks the last strike and follows the sliders', async () => {
  await open();
  expect(dot()).toBeNull();

  close?.();
  await open(64);
  const soft = dot()!;
  expect(soft.getAttribute('data-strike')).toBe('64');

  // A harder curve lifts the same strike, so the dot rises and the headroom above it shrinks.
  const under = Number(soft.getAttribute('cy'));
  await move('Velocity curve', '100');
  await vi.waitFor(() => expect(Number(dot()!.getAttribute('cy'))).toBeLessThan(under));

  // It stayed where it was struck: only the level it came out at moved.
  expect(dot()!.getAttribute('cx')).toBe(soft.getAttribute('cx'));
});
