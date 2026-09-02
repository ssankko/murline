// A stand-in for the Tauri runtime, loaded before the app when the address carries ?mocktauri.
// A plain browser then runs the whole start-up against faked answers, so the screens can be
// watched without `tauri dev`. Every command, event, setting and piece comes from the same
// in-memory Rust side the tests use.
//
// The address can fill the library and the settings:
//   ?mocktauri&piece=prelude28-01.musicxml   one fixture from src-tauri/fixtures as the library
//   &s.keyboard_preset=25&s.sheet_split=0.5   any global setting, as JSON, under an `s.` prefix
//   &p.position_tick=38400                    any `piece` column, as JSON, under a `p.` prefix
//   &update=0.1.1                             a version waiting on the release page

import {
  DEFAULT_ANSWERS,
  fakeFiles,
  fakeRust,
  fakeSettings,
  refusal,
  type FakeRust,
} from '@/rust.fake';
import { mockWindows } from '@tauri-apps/api/mocks';

export function installTauriMock(): void {
  const params = new URLSearchParams(location.search);
  const pieces = params.getAll('piece');
  const columns = Object.fromEntries(
    [...params].filter(([key]) => key.startsWith('p.')).map(([key, value]) => [key.slice(2), JSON.parse(value)]),
  );
  // The window the drag-and-drop and the fullscreen toggle ask for.
  mockWindows('main');
  const fake = fakeRust({
    piece_get: (args) => {
      const row = DEFAULT_ANSWERS.piece_get(args);
      return row && Object.assign(row, columns);
    },
    update_check: () => params.get('update'),
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
