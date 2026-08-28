// A stand-in for the Tauri runtime, loaded before the app when the address carries ?mocktauri.
// A plain browser then runs the whole start-up — database, sound engine, library — against faked
// answers, so the boot screen can be watched and measured without `tauri dev`. The sampler rides
// along, recording every visual state change of the boot for as long as it runs.

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

/** How many slow calls the mock has served; each one costs more, so a second run lags a first. */
let nth = 0;

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
      // The waits make the two StrictMode boot runs stagger the way they do against the real
      // engine: every call costs more than the one before, so the second run falls behind.
      if (cmd.startsWith('audio_') || cmd === 'list_library') {
        nth += 1;
        await new Promise((r) => setTimeout(r, Math.min(nth * 60, 1200)));
      }
      if (cmd === 'plugin:sql|load') return 'sqlite:piano.db';
      if (cmd === 'plugin:sql|select') return rows(String(args?.query ?? ''));
      if (cmd === 'plugin:sql|execute') return [0, 0];
      if (cmd === 'list_library') return [];
      if (cmd === 'audio_instruments') return [{ id: 'mock', name: 'Concert Grand Piano' }];
      return 0;
    },
  };
}

/** Samples the boot on every DOM commit, recording only the commits where something changed. */
export function watchBoot(): void {
  type Sample = { t: number; screen: string; lines: number; layer: number | null };
  const samples: Sample[] = [];
  (window as unknown as Record<string, unknown>).__bootSamples = samples;
  let last = '';
  const t0 = performance.now();
  const read = () => {
    const boot = document.querySelector('.boot');
    const cover = boot?.parentElement;
    const fixed = cover && getComputedStyle(cover).position === 'fixed';
    const sample = {
      screen: document.body.textContent?.includes('Pick the folder')
        ? 'onboarding'
        : boot
          ? 'boot'
          : 'library',
      lines: boot ? (boot.textContent?.split('\n').length ?? 0) : 0,
      layer: fixed ? Number(getComputedStyle(cover!).opacity) : null,
    };
    const now = JSON.stringify(sample);
    if (now !== last) {
      last = now;
      samples.push({ t: Math.round(performance.now() - t0), ...sample });
    }
  };
  new MutationObserver(read).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['style'],
  });
  read();
}
