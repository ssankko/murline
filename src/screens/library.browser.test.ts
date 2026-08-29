import { findsPieces, nextRow } from '@/screens/library';
import { expect, test } from 'vitest';

/** A key press as the window handler sees it, with only the parts the guard reads. */
function press(key: string, metaKey = true): KeyboardEvent {
  return { key, metaKey } as KeyboardEvent;
}

test('⌘F reaches the search field, and stands back for a dialog over the screen', () => {
  expect(findsPieces(press('f'), false)).toBe(true);
  expect(findsPieces(press('f', false), false)).toBe(false);
  expect(findsPieces(press('g'), false)).toBe(false);
  // The finder and the settings panel own every key while they stand, ⌘F with them.
  expect(findsPieces(press('f'), true)).toBe(false);
});

test('the arrows walk the shown rows and hold at both ends', () => {
  expect(nextRow(5, 0, 1)).toBe(1);
  expect(nextRow(5, 4, 1)).toBe(4);
  expect(nextRow(5, 2, -1)).toBe(1);
  expect(nextRow(5, 0, -1)).toBe(0);
  // A search that hides the selected row leaves no row to step from, so either arrow takes the first.
  expect(nextRow(5, -1, 1)).toBe(0);
  expect(nextRow(5, -1, -1)).toBe(0);
});
