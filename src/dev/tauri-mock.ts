// A stand-in for the Tauri runtime, loaded before the app when the address carries ?mocktauri.
// A plain browser then runs the whole start-up — database, sound engine, library — against faked
// answers, so the screens can be watched without `tauri dev`.

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
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriMock };
  if (w.__TAURI_INTERNALS__) return;
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label: 'main' }, currentWindow: { label: 'main' } },
    transformCallback: (cb) => cb,
    isTauri: true,
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'plugin:sql|load') return 'sqlite:piano.db';
      if (cmd === 'plugin:sql|select') return rows(String(args?.query ?? ''));
      if (cmd === 'plugin:sql|execute') return [0, 0];
      if (cmd === 'list_library') return [];
      if (cmd === 'audio_instruments') return [{ id: 'mock', name: 'Concert Grand Piano' }];
      return 0;
    },
  };
}
