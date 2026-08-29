import { isBlackKey, noteName } from '@/score/pitch';
import { expect, test } from 'vitest';

test('note names and black keys follow the same pitch class', () => {
  expect(noteName(60)).toBe('C4');
  expect(noteName(21)).toBe('A0');
  expect(noteName(61)).toBe('C♯4');
  expect(isBlackKey(61)).toBe(true);
  expect(isBlackKey(60)).toBe(false);
});
