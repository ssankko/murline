import { KEYBOARD_H, drawKeyboard, keyLayout } from '@/lane/keyboard';
import { INK, PAPER, tone } from '@/look/color';
import { expect, test } from 'vitest';

const WIDTH = 700;

/** One octave of keys on its paper, painted by `fill`, ready to read pixels from. */
function draw(
  fill: (midi: number, base: string) => string,
  depth?: (midi: number) => number,
  dark = false,
): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = KEYBOARD_H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = tone(PAPER, dark);
  ctx.fillRect(0, 0, WIDTH, KEYBOARD_H);
  drawKeyboard(ctx, keyLayout(60, 71, WIDTH), 0, dark, false, fill, depth);
  return ctx;
}

/** Presses one key all the way down and leaves the rest up. */
const only = (pressed: number) => (midi: number) => (midi === pressed ? 1 : 0);

/** The hex at a point of the canvas. */
function pixel(ctx: CanvasRenderingContext2D, x: number, y: number): string {
  const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
  return `#${[r, g, b].map((v) => v!.toString(16).padStart(2, '0')).join('')}`;
}

/** The hex at a column, below the black keys where only a white key can be. */
function at(ctx: CanvasRenderingContext2D, x: number): string {
  return pixel(ctx, x, KEYBOARD_H - 8);
}

test('a white key is a flat face with a hairline of paper at its edge', () => {
  const ctx = draw((_midi, base) => base);
  // C4 spans x 0 to 99: face to 98, then the paper the next key starts from.
  expect(at(ctx, 50)).toBe('#dedede');
  expect(at(ctx, 99)).toBe(tone(PAPER, false));
});

test('a missed key blinks in a grey, never in a pitch colour', () => {
  const ctx = draw((midi, base) => (midi === 60 ? tone(INK.miss, false) : base));
  const [r, g, b] = ctx.getImageData(50, KEYBOARD_H - 8, 1, 1).data;
  expect([g, b]).toEqual([r, r]);
});

test('a pressed key sinks under a strip of its own face, shaded deeper', () => {
  const ctx = draw((_midi, base) => base, only(60));
  // C4 sinks four pixels under its strip; the key beside it keeps the flat face.
  expect(pixel(ctx, 50, 1)).toBe('#ababab');
  expect(pixel(ctx, 50, 5)).toBe('#d1d1d1');
  expect(pixel(ctx, 150, 1)).toBe('#dedede');
});

test('the press shades toward the paper: black on light, white on dark', () => {
  const ctx = draw((_midi, base) => base, only(60), true);
  // On dark paper a sunk face lightens instead, so the press reads the same way round.
  expect(pixel(ctx, 50, 1)).toBe('#626262');
  expect(pixel(ctx, 50, 5)).toBe('#404040');
  expect(pixel(ctx, 150, 1)).toBe('#343434');
});

test('a pressed black key sinks whole, keeping its length', () => {
  const ctx = draw((_midi, base) => base, only(61));
  // C#4 wears its strip at the top, its face under it, and reaches four pixels past the 51 it
  // stops at unpressed.
  expect(pixel(ctx, 110, 1)).toBe('#969696');
  expect(pixel(ctx, 110, 10)).toBe('#b7b7b7');
  expect(pixel(ctx, 110, 53)).toBe('#b7b7b7');
  expect(pixel(draw((_midi, base) => base), 110, 53)).toBe('#dedede');
});

test('a key half way down sinks half as far', () => {
  const ctx = draw(
    (_midi, base) => base,
    (midi) => (midi === 60 ? 0.5 : 0),
  );
  // Two pixels of strip over a face shaded half as much as a key all the way down.
  expect(pixel(ctx, 50, 1)).toBe('#b0b0b0');
  expect(pixel(ctx, 50, 3)).toBe('#d7d7d7');
});
