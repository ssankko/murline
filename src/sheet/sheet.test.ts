import { expect, test } from 'vitest';
import { bubbleRows } from './sheet';

test('a chord bubble drops to the second row only where it would print over the one before it', () => {
  const wide = { width: 40 };
  expect(
    bubbleRows([
      { x: 0, ...wide },
      { x: 30, ...wide },
      { x: 200, ...wide },
      { x: 230, ...wide },
      { x: 400, ...wide },
    ]),
  ).toEqual([0, 1, 0, 1, 0]);
});
