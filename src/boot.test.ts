import { expect, test, vi } from 'vitest';

let settings = {
  theme: 'dark',
  onboarding_done: true,
  library_folder: '/scores',
  audio_output_device: 'Scarlett',
  audio_buffer_frames: 128,
};
let engineReason: string | null = null;
/** A command that answers with this reason instead of doing what it was asked. */
let refuses: string | null = null;
const sent: [string, unknown][] = [];

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
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: unknown) => {
    sent.push([command, args]);
    if (command === 'audio_start' && engineReason) throw engineReason;
    if (command === refuses) throw `${command} would not`;
    if (command === 'audio_instruments') return [];
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
    '> starting sound engine … ok',
    '> scanning /scores … ok',
  ]);
  // Each report holds the lines printed so far and no more.
  expect(printed.map((lines) => lines.length)).toEqual([1, 2, 3, 4, 5, 6]);
});

test('the sound engine starts on the device and buffer the settings hold', async () => {
  sent.length = 0;
  await boot(() => {});
  expect(sent).toContainEqual(['audio_set_output_device', { id: 'Scarlett' }]);
  expect(sent).toContainEqual(['audio_set_buffer_frames', { frames: 128 }]);
});

test('a step that fails prints its reason', async () => {
  settings = { ...settings, library_folder: '/gone' };
  const printed: string[][] = [];
  await boot((lines) => printed.push(lines));
  expect(printed[printed.length - 1]![5]).toBe('> scanning /gone … folder is gone');
});

test('a setting the engine refuses still leaves the chain applied, and prints why', async () => {
  sent.length = 0;
  refuses = 'audio_set_buffer_frames';
  const printed: string[][] = [];
  await boot((lines) => printed.push(lines));
  refuses = null;

  expect(printed[printed.length - 1]![4]).toBe(
    '> starting sound engine … audio_set_buffer_frames would not',
  );
  // The buffer is what failed; the instrument and the chain after it went in all the same.
  expect(sent.map(([command]) => command)).toContain('audio_set_chain');
  expect(sent.map(([command]) => command)).toContain('audio_instruments');
});

test('a sound engine that will not start prints why, and the steps after it still run', async () => {
  settings = { ...settings, library_folder: '/scores' };
  engineReason = 'No sound engine on this platform';
  const printed: string[][] = [];
  await boot((lines) => printed.push(lines));
  expect(printed[printed.length - 1]!.slice(4)).toEqual([
    '> starting sound engine … No sound engine on this platform',
    '> scanning /scores … ok',
  ]);
  engineReason = null;
});
