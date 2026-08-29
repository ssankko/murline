import { sticky } from '@/lib/utils';
import { expect, test } from 'vitest';

test('a value inside the band lands on the multiple, one outside it stays where it is', () => {
  expect([48, 49, 50, 51, 52].map((each) => sticky(each))).toEqual([50, 50, 50, 50, 50]);
  expect([98, 100, 102].map((each) => sticky(each))).toEqual([100, 100, 100]);
  expect([53, 47, 5, 195].map((each) => sticky(each))).toEqual([53, 47, 5, 195]);
});

test('the ends of a range stick too', () => {
  expect(sticky(2)).toBe(0);
  expect(sticky(198, 10, 2)).toBe(200);
});
