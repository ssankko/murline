// The start-up sequence: the work the app does before its first screen, and the line each step
// prints when it lands. The boot screen in src/App.tsx shows the lines as they arrive.

import { getDb, readSettings, type Settings } from '@/db/db';
import { reasonOf } from '@/library/notice';
import { scanLibrary } from '@/library/scan';
import { setTheme } from '@/look/use-dark';

/**
 * Runs the start-up steps in order, reporting every line printed so far after each one, and
 * resolves with the settings the app routes on. A step that fails prints its reason and the steps
 * after it still run, so a database that will not open lands on onboarding with the reason on
 * screen.
 */
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

  // The library screen walks the same folder on mount, and `scanLibrary` walks a folder once, so
  // the wait for it happens here instead of behind an empty list.
  if (settings.onboarding_done && settings.library_folder) {
    await step(`scanning ${settings.library_folder}`, () => scanLibrary(settings.library_folder));
  }
  return settings;
}
