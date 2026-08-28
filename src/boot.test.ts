import { expect, test, vi } from 'vitest';
import type { BootLine } from './boot';

let settings = {
  theme: 'dark',
  onboarding_done: true,
  library_folder: '/scores',
  audio_output_device: 'Scarlett',
  audio_buffer_frames: 128,
  instruments_folder: '/instruments',
  instrument_id: 'grand' as string | null,
};
let engineReason: string | null = null;
/** A command that answers with this reason instead of doing what it was asked. */
let refuses: string | null = null;
/** What the engine answers for its instrument list while it is set. */
let listed: { id: string; name: string }[] = [];
/** While it is set, the scan waits on it, so a step can be watched in flight. */
let heldScan: Promise<void> | null = null;
const sent: [string, unknown][] = [];

vi.mock('@/db/db', () => ({
  getDb: async () => ({}),
  readSettings: async () => settings,
  setSetting: async () => {},
  getSettingOr: async () => ({}),
}));
vi.mock('@/look/use-dark', () => ({ setTheme: () => {} }));
vi.mock('@/library/scan', () => ({
  scanLibrary: async (folder: string) => {
    if (folder === '/gone') throw new Error('folder is gone');
    if (heldScan) await heldScan;
  },
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: unknown) => {
    sent.push([command, args]);
    if (command === 'audio_start' && engineReason) throw engineReason;
    if (command === refuses) throw `${command} would not`;
    // Nothing but the instrument list answers without the engine, and every failure answers alike.
    if (engineReason && command !== 'audio_instruments') throw engineReason;
    if (command === 'audio_instruments') return listed;
  },
}));

const { boot, lineText, START_LINE } = await import('./boot');

/** The log of a boot where every step lands, with the settings' instrument named. */
const landedLog: BootLine[] = [
  { label: 'starting', state: 'ok' },
  { label: 'opening database', state: 'ok' },
  { label: 'reading settings', state: 'ok' },
  { label: 'theme: dark', state: 'note' },
  { label: 'starting sound engine', state: 'ok' },
  { label: 'restoring Concert Grand Piano', state: 'ok' },
  { label: 'scanning /scores', state: 'ok' },
];

test('the first line is the one index.html paints, and boot lands it at once', async () => {
  const printed: BootLine[][] = [];
  await boot((lines) => printed.push(lines));
  expect(lineText(START_LINE)).toBe('> starting …');
  expect(printed[0]).toEqual([{ label: START_LINE.label, state: 'ok' }]);
});

test('every step names itself while it runs, in the order the steps run', async () => {
  listed = [{ id: 'grand', name: 'Concert Grand Piano' }];
  const printed: BootLine[][] = [];
  await boot((lines) => printed.push(lines));
  expect(printed[printed.length - 1]).toEqual(landedLog);
  // A step's line appears alone and lands in place: the two prints for one step hold the same count.
  expect(printed.map((lines) => lines.length)).toEqual([1, 2, 2, 3, 4, 5, 5, 6, 6, 7, 7]);
  listed = [];
});

test('a step in flight reads with no tail, and its tail flips when the step lands', async () => {
  let release!: () => void;
  heldScan = new Promise<void>((resolve) => (release = resolve));
  try {
    const printed: BootLine[][] = [];
    const done = boot((lines) => printed.push(lines));
    // One turn of the loop lets the log reach the held scan and stop there.
    await new Promise((resolve) => setTimeout(resolve));
    const last = printed[printed.length - 1]!;
    expect(last[last.length - 1]).toEqual({ label: 'scanning /scores', state: 'running' });
    release();
    await done;
    expect(printed[printed.length - 1]![6]).toEqual({ label: 'scanning /scores', state: 'ok' });
  } finally {
    heldScan = null;
  }
});

test('a step that fails shows the reason as its tail, and the steps after it still run', async () => {
  settings = { ...settings, library_folder: '/gone' };
  const printed: BootLine[][] = [];
  await boot((lines) => printed.push(lines));
  const last = printed[printed.length - 1]!;
  expect(last[last.length - 1]).toEqual({
    label: 'scanning /gone',
    state: 'failed',
    reason: 'folder is gone',
  });
  settings = { ...settings, library_folder: '/scores' };
});

test('a setting the engine refuses still leaves the chain applied, and prints why', async () => {
  sent.length = 0;
  refuses = 'audio_set_buffer_frames';
  const printed: BootLine[][] = [];
  await boot((lines) => printed.push(lines));
  refuses = null;

  expect(printed[printed.length - 1]![4]).toEqual({
    label: 'starting sound engine',
    state: 'failed',
    reason: 'audio_set_buffer_frames would not',
  });
  // The buffer is what failed; the instrument and the chain after it went in all the same.
  expect(sent.map(([command]) => command)).toContain('audio_set_chain');
  expect(sent.map(([command]) => command)).toContain('audio_instruments');
});

test('a sound engine that will not start prints why, and the steps after it still run', async () => {
  settings = { ...settings, library_folder: '/scores' };
  engineReason = 'No sound engine on this platform';
  const printed: BootLine[][] = [];
  await boot((lines) => printed.push(lines));
  expect(printed[printed.length - 1]!.slice(4)).toEqual([
    {
      label: 'starting sound engine',
      state: 'failed',
      reason: 'No sound engine on this platform',
    },
    { label: 'restoring instrument', state: 'failed', reason: 'No sound engine on this platform' },
    { label: 'scanning /scores', state: 'ok' },
  ]);
  engineReason = null;
});

test('the line names the instrument the settings chose, when the list knows it', async () => {
  listed = [{ id: 'grand', name: 'Concert Grand Piano' }];
  const printed: BootLine[][] = [];
  await boot((lines) => printed.push(lines));
  expect(printed[printed.length - 1]![5]).toEqual({
    label: 'restoring Concert Grand Piano',
    state: 'ok',
  });
  listed = [];
});

test('a first boot names the instrument the restore falls back to', async () => {
  listed = [{ id: 'grand', name: 'Concert Grand Piano' }];
  settings = { ...settings, instrument_id: null };
  const printed: BootLine[][] = [];
  await boot((lines) => printed.push(lines));
  expect(printed[printed.length - 1]![5]!.label).toBe('restoring Concert Grand Piano');
  settings = { ...settings, instrument_id: 'grand' };
  listed = [];
});
