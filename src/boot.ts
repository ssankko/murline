// The start-up sequence: the work the app does before its first screen, and the line each step
// prints when it lands. The boot screen in src/App.tsx shows the lines as they arrive.

import { restoreInstrument } from '@/audio/instrument';
import { restoreRoles } from '@/audio/roles';
import { getDb, readSettings, type Settings } from '@/db/db';
import { reasonOf } from '@/library/notice';
import { scanLibrary } from '@/library/scan';
import { setTheme } from '@/look/use-dark';
import { invoke } from '@tauri-apps/api/core';

/**
 * Runs the start-up steps in order, reporting every line printed so far after each one, and
 * resolves with the settings the app routes on. A step that fails prints its reason and the steps
 * after it still run, so a database that will not open lands on onboarding with the reason on
 * screen.
 */
/** Why a call failed, or an empty string when it did not. */
async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return '';
  } catch (error) {
    return reasonOf(error);
  }
}

export async function boot(print: (lines: string[]) => void): Promise<Settings> {
  const lines: string[] = [];
  const say = (line: string): void => {
    lines.push(line);
    print([...lines]);
  };
  const step = async (label: string, run: () => Promise<unknown>): Promise<boolean> => {
    try {
      await run();
      say(`> ${label} … ok`);
      return true;
    } catch (error) {
      say(`> ${label} … ${reasonOf(error)}`);
      return false;
    }
  };

  // index.html paints this line while the bundle loads; here it lands.
  say('> starting … ok');
  const opened = await step('opening database', getDb);
  const settings = await readSettings();
  if (opened) say('> reading settings … ok');
  setTheme(settings.theme);
  say(`> theme: ${settings.theme}`);

  await step('starting sound engine', async () => {
    await invoke('audio_start');
    // Every setting is applied whatever the one before it did: a device that has been unplugged or
    // an instrument file that will not load must not cost the app its effect chain. Only the start
    // itself stops the rest, because nothing can be applied to an engine that is not there.
    const reasons = [
      await failure(() => invoke('audio_set_output_device', { id: settings.audio_output_device })),
      await failure(() =>
        invoke('audio_set_buffer_frames', { frames: settings.audio_buffer_frames }),
      ),
      await failure(() => restoreInstrument(settings)),
      // After the load, which is what leaves every role of the instrument on.
      await failure(() => restoreRoles(settings.instrument_id)),
      await failure(() => invoke('audio_set_chain', { chain: settings.effect_chain })),
      await failure(() =>
        invoke('audio_set_keyboard_volume', { percent: settings.keyboard_volume }),
      ),
      await failure(() =>
        invoke('audio_set_velocity_curve', {
          min: settings.velocity_min,
          max: settings.velocity_max,
          curve: settings.velocity_curve,
        }),
      ),
    ];
    const first = reasons.find(Boolean);
    if (first) throw new Error(first);
  });

  // The library screen walks the same folder on mount, and `scanLibrary` walks a folder once, so
  // the wait for it happens here instead of behind an empty list.
  if (settings.onboarding_done && settings.library_folder) {
    await step(`scanning ${settings.library_folder}`, () => scanLibrary(settings.library_folder));
  }
  return settings;
}
