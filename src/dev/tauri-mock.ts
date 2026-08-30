// A stand-in for the Tauri runtime, loaded before the app when the address carries ?mocktauri.
// A plain browser then runs the whole start-up against faked answers, so the screens can be
// watched without `tauri dev`. Every command, event, setting and piece comes from the same
// in-memory Rust side the tests use, on an empty library.

import { fakeRust, fakeSettings } from '@/rust.fake';

type TauriMock = {
  invoke: () => Promise<unknown>;
  transformCallback: (cb: unknown) => unknown;
  metadata: { currentWebview: { label: string }; currentWindow: { label: string } };
  isTauri: boolean;
};

export function installTauriMock(): void {
  fakeRust();
  // Onboarding done, on one library folder, so the mock opens on the library page.
  fakeSettings.set('onboarding_done', true);
  fakeSettings.set('library_folder', '/Users/mock/Scores');
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriMock };
  if (w.__TAURI_INTERNALS__) return;
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label: 'main' }, currentWindow: { label: 'main' } },
    transformCallback: (cb) => cb,
    isTauri: true,
    invoke: async () => 0,
  };
}
