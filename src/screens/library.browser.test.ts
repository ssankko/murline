import { findsPieces } from '@/screens/library';
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
