import { expect, test, vi } from 'vitest';

let settings = { theme: 'dark', onboarding_done: true, library_folder: '/scores' };

vi.mock('@/db/db', () => ({
  getDb: async () => ({}),
  readSettings: async () => settings,
}));
vi.mock('@/look/use-dark', () => ({ setTheme: () => {} }));
vi.mock('@/library/scan', () => ({
  scanLibrary: async (folder: string) => {
    if (folder === '/gone') throw new Error('folder is gone');
  },
}));

const { boot } = await import('./boot');

test('every step prints its line, in the order the steps run', async () => {
  const printed: string[][] = [];
  await boot((lines) => printed.push(lines));
  expect(printed[printed.length - 1]).toEqual([
    '> starting … ok',
    '> opening database … ok',
    '> reading settings … ok',
    '> theme: dark',
    '> scanning /scores … ok',
  ]);
  // Each report holds the lines printed so far and no more.
  expect(printed.map((lines) => lines.length)).toEqual([1, 2, 3, 4, 5]);
});

test('a step that fails prints its reason', async () => {
  settings = { ...settings, library_folder: '/gone' };
  const printed: string[][] = [];
  await boot((lines) => printed.push(lines));
  expect(printed[printed.length - 1]![4]).toBe('> scanning /gone … folder is gone');
});
