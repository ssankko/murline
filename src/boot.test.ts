import type { CommandName } from '@/rust';
import { DEFAULT_ANSWERS, fakeRust, fakeSettings, type Answers } from '@/rust.fake';
import { beforeEach, expect, test, vi } from 'vitest';
import type { BootLine } from './boot';

/** The stored settings a boot starts from, put in the fake's table before every test. */
const STORED: Record<string, unknown> = {
  theme: 'dark',
  onboarding_done: true,
  library_folder: '/scores',
  audio_output_device: 'Scarlett',
  audio_buffer_frames: 128,
  instruments_folder: '/instruments',
  instrument_id: 'grand',
};
let engineReason: string | null = null;
/** What the engine answers for its instrument list while it is set. */
let listed: { id: string; name: string }[] = [];
/** While it is set, the scan waits on it, so a step can be watched in flight. */
let heldScan: Promise<void> | null = null;

vi.mock('@/db/db', () => ({ getDb: async () => ({}) }));
// The paper is the window's, and this test has none.
vi.mock('@/look/use-dark', () => ({ useDark: () => false }));
vi.mock('@/library/scan', () => ({
  scanLibrary: async (folder: string) => {
    if (folder === '/gone') throw new Error('folder is gone');
    if (heldScan) await heldScan;
  },
}));
/** Every command but the settings answers the way a refusing or an absent engine would. */
const answers = Object.fromEntries(
  (Object.keys(DEFAULT_ANSWERS) as CommandName[])
    .filter((command) => command !== 'settings_read' && command !== 'settings_write')
    .map((command) => [
      command,
      () => {
        // Nothing but the instrument list answers without the engine, and every failure is alike.
        if (engineReason && command !== 'audio_instruments') throw engineReason;
        if (command === 'audio_instruments') return listed;
      },
    ]),
) as Partial<Answers>;

beforeEach(() => {
  fakeRust(answers);
  for (const [key, value] of Object.entries(STORED)) fakeSettings.set(key, value);
});

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
  expect(printed.map((lines) => lines.length)).toEqual([1, 2, 2, 3, 3, 4, 5, 5, 6, 6, 7, 7]);
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
  fakeSettings.set('library_folder', '/gone');
  const printed: BootLine[][] = [];
  await boot((lines) => printed.push(lines));
  const last = printed[printed.length - 1]!;
  expect(last[last.length - 1]).toEqual({
    label: 'scanning /gone',
    state: 'failed',
    reason: 'folder is gone',
  });
});

// The engine puts its own settings back, so what the boot log carries is the one reason it
// answers with; the steps after it run whatever it was.
test('a sound engine that will not start prints why, and the steps after it still run', async () => {
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
  fakeSettings.delete('instrument_id');
  const printed: BootLine[][] = [];
  await boot((lines) => printed.push(lines));
  expect(printed[printed.length - 1]![5]!.label).toBe('restoring Concert Grand Piano');
  listed = [];
});
