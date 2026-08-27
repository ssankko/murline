import { expect, test } from 'vitest';
import { bubblePlaces } from './sheet';

const wide = { width: 40 };
const free = [[], []];

test('a chord bubble drops to the second row only where it would print over the one before it', () => {
  const xs = [0, 30, 200, 230, 400];
  const rows = bubblePlaces(xs.map((x) => ({ x, ...wide })), free);

  expect(rows.map((at) => at.row)).toEqual([0, 1, 0, 1, 0]);
  expect(rows.map((at) => at.x)).toEqual(xs);
});

test('a chord bubble takes the row a label leaves free, and moves right of a label in both', () => {
  const label = [{ left: 0, right: 100 }];

  expect(bubblePlaces([{ x: 100, ...wide }], [label, []])[0]).toEqual({ x: 100, row: 1 });
  expect(bubblePlaces([{ x: 100, ...wide }], [label, label])[0]).toEqual({ x: 126, row: 0 });
});
