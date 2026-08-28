import { expect, test } from 'vitest';
import { SPACING_MAX, SPACING_MIN, clampSpacing, wheelSpacing } from './pinch';

test('a spread across the whole trackpad about doubles the spacing, and a squeeze halves it', () => {
  expect(clampSpacing(wheelSpacing(100, -70))).toBe(201);
  expect(clampSpacing(wheelSpacing(200, 70))).toBe(99);
  // A wheel that did not move leaves the spacing where it stands.
  expect(wheelSpacing(150, 0)).toBe(150);
});

test('a pinch lands on a whole percent inside the range the slider writes', () => {
  expect(clampSpacing(153.75)).toBe(154);
  expect(clampSpacing(wheelSpacing(150, -70))).toBe(SPACING_MAX);
  expect(clampSpacing(wheelSpacing(100, 70))).toBe(SPACING_MIN);
});
