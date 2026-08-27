import { colorOf, isBlackKey, labelInk, noteName, PAPER } from '@/look/color';
import { expect, test } from 'vitest';

// The twelve hexes the spec fixes for the muted palette, C through B.
const LIGHT =
  '#cc3b33 #764c37 #cc9433 #767137 #adcc33 #33cc59 #377664 #33b3cc #374a76 #5433cc #6e3776 #cc3380';
const DARK =
  '#d6625c #996348 #d6a95c #999248 #bed65c #5cd67a #489982 #5cc2d6 #486099 #765cd6 #8e4899 #d65c99';

const octave = (dark: boolean) =>
  Array.from({ length: 12 }, (_, pc) => colorOf(60 + pc, 'muted', dark)).join(' ');

test('the muted palette matches the spec on light and dark paper', () => {
  expect(octave(false)).toBe(LIGHT);
  expect(octave(true)).toBe(DARK);
});

test('note names and black keys follow the same pitch class', () => {
  expect(noteName(60)).toBe('C4');
  expect(noteName(21)).toBe('A0');
  expect(isBlackKey(61)).toBe(true);
  expect(isBlackKey(60)).toBe(false);
});

test('a label takes the ink its fill leaves readable', () => {
  // A hit flashes white and a bright pitch stays light, so both carry the dark ink; a deep blue,
  // a dark-paper block and the grey of a miss on light paper carry the light one.
  expect(labelInk('#ffffff')).toBe(PAPER[1]);
  expect(labelInk('#adcc33')).toBe(PAPER[1]);
  expect(labelInk('#5433cc')).toBe(PAPER[0]);
  expect(labelInk('#202020')).toBe(PAPER[0]);
  expect(labelInk('#6b6b6b')).toBe(PAPER[0]);
});
