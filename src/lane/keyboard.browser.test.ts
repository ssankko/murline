import { KEYBOARD_H, drawKeyboard, keyLayout } from '@/lane/keyboard';
import { INK, PAPER, tone } from '@/look/color';
import { expect, test } from 'vitest';

const WIDTH = 700;

/** One octave of keys on light paper, painted by `fill`, ready to read pixels from. */
function draw(
  fill: (midi: number, base: string) => string,
  pressed?: (midi: number) => boolean,
): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH;
  canvas.height = KEYBOARD_H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = tone(PAPER, false);
  ctx.fillRect(0, 0, WIDTH, KEYBOARD_H);
  drawKeyboard(ctx, keyLayout(60, 71, WIDTH), 0, false, false, fill, pressed);
  return ctx;
}

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

test('a pressed key sinks under a shadow strip, its whole face darker', () => {
  const ctx = draw(
    (_midi, base) => base,
    (midi) => midi === 60,
  );
  // C4 sinks four pixels under a strip a third of the way to black, and the face it sank to is its
  // own a little darker. The key beside it keeps the flat face.
  expect(pixel(ctx, 50, 1)).toBe('#7f7f7f');
  expect(pixel(ctx, 50, 5)).toBe('#c3c3c3');
  expect(pixel(ctx, 150, 1)).toBe('#dedede');
});

test('a pressed black key shortens and darkens', () => {
  const ctx = draw(
    (_midi, base) => base,
    (midi) => midi === 61,
  );
  // C#4 wears its face darker down to y 47, four pixels short of the 51 it reaches unpressed.
  expect(pixel(ctx, 110, 40)).toBe('#acacac');
  expect(pixel(ctx, 110, 50)).toBe('#dedede');
});
