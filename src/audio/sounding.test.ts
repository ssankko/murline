import { sounded, type Sounding } from '@/audio/sounding';
import type { StrikeEvent } from '@/play/engine';
import { expect, test } from 'vitest';

function strike(midi: number, on: boolean, velocity = on ? 80 : 0): StrikeEvent {
  return { midi, velocity, time: 0, on };
}

test('a chord keeps every key, and striking one again replaces only that one', () => {
  let all: Sounding[] = [];
  all = sounded(all, strike(60, true), 0);
  all = sounded(all, strike(64, true), 10);
  all = sounded(all, strike(60, true, 100), 20);
  expect(all.map((one) => [one.midi, one.velocity])).toEqual([
    [64, 80],
    [60, 100],
  ]);
});

test('a key coming up keeps what it was struck at and says how long it was held', () => {
  const down = sounded([], strike(60, true, 90), 100);
  const up = sounded(down, strike(60, false), 700)[0]!;
  expect(up).toMatchObject({ midi: 60, velocity: 90, on: false, at: 700, held: 600 });
});

test('a key that came up long ago is dropped, one still down is not', () => {
  const old: Sounding[] = [
    { midi: 60, velocity: 80, on: false, at: 0, held: 100 },
    { midi: 62, velocity: 80, on: true, at: 0, held: 0 },
  ];
  expect(sounded(old, strike(67, true), 9000).map((one) => one.midi)).toEqual([62, 67]);
});
