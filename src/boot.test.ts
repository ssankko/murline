import {
  DEFAULT_ANSWERS,
  fakeRust,
  fakeSettings,
  refusal,
  type Answers,
  type CommandName,
  type FakeRust,
} from '@/rust.fake';
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
/** While it is set, the scan tells `reached` it started and then waits on `held`, so a step can be
 * watched in flight. */
let heldScan: { reached: () => void; held: Promise<void> } | null = null;

// The paper is the window's, and this test has none.
vi.mock('@/look/use-dark', () => ({ useDark: () => false }));
vi.mock('@/library/scan', () => ({
  scanLibrary: async (folder: string) => {
    if (folder === '/gone') throw new Error('folder is gone');
    if (heldScan) {
      heldScan.reached();
      await heldScan.held;
    }
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
        if (engineReason && command !== 'audio_instruments') throw refusal('refused', engineReason);
        return command === 'audio_instruments' ? listed : undefined;
      },
    ]),
) as Partial<Answers>;

let rust: FakeRust;

beforeEach(() => {
  rust = fakeRust(answers);
  for (const [key, value] of Object.entries(STORED)) fakeSettings.set(key, value);
});

const { boot, lineText, START_LINE } = await import('./boot');

/** The log of a boot where every step lands, with the settings' instrument named. */
const landedLog: BootLine[] = [
  { label: 'starting', state: 'ok' },
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
  expect(printed.map((lines) => lines.length)).toEqual([1, 2, 2, 3, 4, 4, 5, 5, 6, 6]);
  listed = [];
});

test('a step in flight reads with no tail, and its tail flips when the step lands', async () => {
  let release!: () => void;
  let reached!: () => void;
  const scanning = new Promise<void>((resolve) => (reached = resolve));
  heldScan = { reached, held: new Promise<void>((resolve) => (release = resolve)) };
  try {
    const printed: BootLine[][] = [];
    const done = boot((lines) => printed.push(lines));
    await scanning;
    const last = printed[printed.length - 1]!;
    expect(last[last.length - 1]).toEqual({ label: 'scanning /scores', state: 'running' });
    release();
    await done;
    expect(printed[printed.length - 1]![5]).toEqual({ label: 'scanning /scores', state: 'ok' });
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
  expect(printed[printed.length - 1]!.slice(3)).toEqual([
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
  expect(printed[printed.length - 1]![4]).toEqual({
    label: 'restoring Concert Grand Piano',
    state: 'ok',
  });
  listed = [];
});

// The name the Rust side leaves behind when a load never comes back: the app went down inside it,
// so this launch leaves that instrument out instead of going down the same way.
test('an instrument the last load never came back from is left out, and the line says which', async () => {
  listed = [{ id: 'grand', name: 'Concert Grand Piano' }];
  fakeSettings.set('instrument_loading', 'grand');
  const printed: BootLine[][] = [];
  await boot((lines) => printed.push(lines));
  const restoring = printed[printed.length - 1]![4]!;
  expect(restoring.state).toBe('failed');
  expect(restoring.reason).toContain('Concert Grand Piano');
  expect(restoring.reason).toContain('did not finish loading last time');
  // Nothing was handed to the engine, so the app is up with no instrument at all.
  expect(rust.argsOf('audio_load_instrument')).toEqual([]);
  listed = [];
});

test('a first boot names the instrument the restore falls back to', async () => {
  listed = [{ id: 'grand', name: 'Concert Grand Piano' }];
  fakeSettings.delete('instrument_id');
  const printed: BootLine[][] = [];
  await boot((lines) => printed.push(lines));
  expect(printed[printed.length - 1]![4]!.label).toBe('restoring Concert Grand Piano');
  listed = [];
});
