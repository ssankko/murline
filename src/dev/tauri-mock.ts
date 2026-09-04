// A stand-in for the Tauri runtime, loaded before the app when the address carries ?mocktauri.
// A plain browser then runs the whole start-up against faked answers, so the screens can be
// watched without `tauri dev`. Every command, event, setting and piece comes from the same
// in-memory Rust side the tests use.
//
// The address can fill the library and the settings:
//   ?mocktauri&piece=prelude28-01.musicxml   one fixture from src-tauri/fixtures as the library
//   &s.keyboard_preset=25&s.sheet_split=0.5   any global setting, as JSON, under an `s.` prefix
//   &p.position_tick=38400                    any `piece` column, as JSON, under a `p.` prefix
//   &update=ok / &update=fail                 a whole update played, ending on disk or on a refusal

import {
  DEFAULT_ANSWERS,
  fakeFiles,
  fakeRust,
  fakeSettings,
  idleUpdate,
  refusal,
  type Answers,
  type FakeRust,
} from '@/rust.fake';
import { mockWindows } from '@tauri-apps/api/mocks';

/** The version the fake release page holds, the bytes its bundle is, and how long the check and
 * each step of the fetch take, so both are slow enough to watch. */
const WAITING = '0.1.1';
const BUNDLE = 34e6;
const CHECK_MS = 1500;
const STEP_MS = 300;
const STEPS = 10;

/**
 * A whole update played out with no release behind it: a check that finds a version, then a fetch
 * counting bytes up through the progress event to the end `kind` names, either the bundle on disk
 * or the reason it stopped.
 */
function playUpdate(kind: string, fake: () => FakeRust): Partial<Answers> {
  const found = { ...idleUpdate(), checked: true, waiting: WAITING };
  return {
    app_version: () => '0.1.0',
    update_check: async () => {
      await new Promise((go) => setTimeout(go, CHECK_MS));
      return found;
    },
    update_install: () => {
      let step = 0;
      const timer = setInterval(() => {
        step++;
        fake().emit('updateProgress', { done: (BUNDLE * step) / STEPS, total: BUNDLE });
        if (step < STEPS) return;
        clearInterval(timer);
        fake().emit(
          'updateDone',
          kind === 'fail'
            ? { ...found, error: 'the bundle could not be written' }
            : { ...found, installed: WAITING },
        );
      }, STEP_MS);
      return { ...found, running: true };
    },
  };
}

export function installTauriMock(): void {
  const params = new URLSearchParams(location.search);
  const pieces = params.getAll('piece');
  const columns = Object.fromEntries(
    [...params].filter(([key]) => key.startsWith('p.')).map(([key, value]) => [key.slice(2), JSON.parse(value)]),
  );
  // The window the drag-and-drop and the fullscreen toggle ask for.
  mockWindows('main');
  const update = params.get('update');
  const fake: FakeRust = fakeRust({
    piece_get: (args) => {
      const row = DEFAULT_ANSWERS.piece_get(args);
      return row && Object.assign(row, columns);
    },
    ...(update ? playUpdate(update, () => fake) : {}),
    read_file: async ({ path }) => {
      const response = await fetch(`/src-tauri/fixtures/${path.split('/').pop()}`);
      if (!response.ok) throw refusal('gone', `no such file: ${path}`);
      return response.arrayBuffer();
    },
  });
  fakeFiles.push(...pieces.map((relPath) => ({ relPath, mtime: 1, size: 1 })));
  // Onboarding done, on one library folder, so the mock opens on the library page.
  fakeSettings.set('onboarding_done', true);
  fakeSettings.set('library_folder', '/Users/mock/Scores');
  for (const [key, value] of params) {
    if (key.startsWith('s.')) fakeSettings.set(key.slice(2), JSON.parse(value));
  }
  // The fake's handle on the window, so the console can send events: `__MURLINE_FAKE__.emit(...)`.
  (window as unknown as { __MURLINE_FAKE__?: FakeRust }).__MURLINE_FAKE__ = fake;
}
