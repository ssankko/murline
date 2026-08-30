// A stand-in for the Tauri runtime, loaded before the app when the address carries ?mocktauri.
// A plain browser then runs the whole start-up against faked answers, so the screens can be
// watched without `tauri dev`. Commands, events and the settings come from the same in-memory
// Rust side the tests use; only `@tauri-apps/plugin-sql`, which still goes through the runtime,
// is faked here, and its library is empty.

import { fakeRust, fakeSettings } from '@/rust.fake';

type TauriMock = {
  invoke: (cmd: string) => Promise<unknown>;
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
    invoke: async (cmd: string) => {
      if (cmd === 'plugin:sql|load') return 'sqlite:murline.db';
      if (cmd === 'plugin:sql|select') return [];
      if (cmd === 'plugin:sql|execute') return [0, 0];
      return 0;
    },
  };
}
