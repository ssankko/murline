// The start-up sequence: the work the app does before its first screen. Every step names itself on
// screen the moment it begins and lands with its tail; the boot screen in src/App.tsx shows the
// lines as they stand.

import { restoreInstrument } from "@/audio/instrument";
import { restoreRoles } from "@/audio/roles";
import { getDb } from "@/db/db";
import { reasonOf } from "@/library/notice";
import { scanLibrary } from "@/library/scan";
import { call } from "@/rust";
import { load, setting } from "@/settings/settings";

/** One line of the boot log. */
export interface BootLine {
  label: string;
  /**
   * Where a step's line stands: `running` while the step works, then `ok`, or `failed` with the
   * reason. A `note` only reports, as the theme line does, and never lands.
   */
  state: "running" | "ok" | "failed" | "note";
  /** Why the step failed; only a failed line carries one. */
  reason?: string;
}

/** The line index.html paints while the bundle loads; App begins with it on screen. */
export const START_LINE: BootLine = { label: "starting", state: "running" };

/** The line as the log shows it: a step names itself and lands with its tail; a note just reports. */
export function lineText(line: BootLine): string {
  if (line.state === "running") return `> ${line.label} …`;
  if (line.state === "note") return `> ${line.label}`;
  return `> ${line.label} … ${line.state === "ok" ? "ok" : line.reason}`;
}

/**
 * Runs the start-up steps in order, reporting the log after every print. A step that fails shows
 * its reason and the steps after it still run, so a database that will not open lands on
 * onboarding with the reason on screen.
 */
export async function boot(print: (lines: BootLine[]) => void): Promise<void> {
  const lines: BootLine[] = [];
  const say = (line: BootLine): void => {
    lines.push(line);
    print([...lines]);
  };
  const land = (from: BootLine, to: BootLine): void => {
    lines[lines.indexOf(from)] = to;
    print([...lines]);
  };
  // A run that answers with a string renames the line it lands under; a line that fails keeps the
  // name it ran under, which is the one that does not need the work to have finished.
  const step = async (
    label: string,
    run: () => Promise<unknown>,
  ): Promise<boolean> => {
    const running: BootLine = { label, state: "running" };
    say(running);
    try {
      const landed = await run();
      land(running, {
        label: typeof landed === "string" ? landed : label,
        state: "ok",
      });
      return true;
    } catch (error) {
      land(running, { label, state: "failed", reason: reasonOf(error) });
      return false;
    }
  };

  // index.html paints the starting line while the bundle loads and App begins with it; the bundle
  // is up by the time boot runs, so the line only has to land.
  say({ label: START_LINE.label, state: "ok" });
  await step("opening database", getDb);
  await step("reading settings", load);
  // The theme is on the paper the moment the settings land, through the subscription in
  // `use-dark.ts`; this line only says which one it is.
  say({ label: `theme: ${setting("theme")}`, state: "note" });

  // The engine puts the stored audio settings back on itself, so a device that has been unplugged
  // is the engine's own reason to report and costs the app none of the rest.
  await step("starting sound engine", () => call("audio_start"));

  await step("restoring instrument", async () => {
    // Both go in whatever the other did; the roles ride on the loaded instrument, so the restore
    // goes first. The landed line names the instrument that went in, when the engine's list knew
    // it.
    const [name, reason] = await restoreInstrument().then(
      (restored) => [restored, ""] as const,
      (error: unknown) => [null, reasonOf(error)] as const,
    );
    const roles = await restoreRoles(setting("instrument_id")).then(
      () => "",
      reasonOf,
    );
    const first = reason || roles;
    if (first) throw new Error(first);
    return name ? `restoring ${name}` : undefined;
  });

  // The library screen walks the same folder on mount, and `scanLibrary` walks a folder once, so
  // the wait for it happens here instead of behind an empty list.
  const folder = setting("library_folder");
  if (setting("onboarding_done") && folder) {
    await step(`scanning ${folder}`, () => scanLibrary(folder));
  }
}
