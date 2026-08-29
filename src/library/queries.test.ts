import { expect, test } from 'vitest';
import { matches } from './queries';

const row = { title: 'Prelude in C', composer: 'J. S. Bach' };

test('the search field keeps a row on either of its two fields, whatever the case', () => {
  expect(matches(row, '')).toBe(true);
  expect(matches(row, '   ')).toBe(true);
  expect(matches(row, '  lude  ')).toBe(true);
  expect(matches(row, 'BACH')).toBe(true);
  expect(matches(row, 'in c')).toBe(true);
  expect(matches(row, 'preludein')).toBe(false);
  expect(matches(row, 'Chopin')).toBe(false);
  expect(matches({ title: null, composer: null }, 'a')).toBe(false);
});
