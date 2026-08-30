// A stand-in for the Tauri runtime, loaded before the app when the address carries ?mocktauri.
// A plain browser then runs the whole start-up against faked answers, so the screens can be
// watched without `tauri dev`. Commands and events come from the same in-memory Rust side the
// tests use; only `@tauri-apps/plugin-sql`, which still goes through the runtime, is faked here.

import { fakeRust } from '@/rust.fake';

type TauriMock = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  transformCallback: (cb: unknown) => unknown;
  metadata: { currentWebview: { label: string }; currentWindow: { label: string } };
  isTauri: boolean;
};

/** The settings a mock database reports: onboarding done, one library folder. */
const WRITTEN: [string, unknown][] = [
  ['onboarding_done', true],
  ['library_folder', '/Users/mock/Scores'],
];

function rows(sql: string): Record<string, string>[] {
  if (sql.includes('FROM setting')) {
    return WRITTEN.map(([key, value]) => ({ key, value: JSON.stringify(value) }));
  }
  return [];
}

export function installTauriMock(): void {
  fakeRust();
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriMock };
  if (w.__TAURI_INTERNALS__) return;
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label: 'main' }, currentWindow: { label: 'main' } },
    transformCallback: (cb) => cb,
    isTauri: true,
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'plugin:sql|load') return 'sqlite:murline.db';
      if (cmd === 'plugin:sql|select') return rows(String(args?.query ?? ''));
      if (cmd === 'plugin:sql|execute') return [0, 0];
      return 0;
    },
  };
}
