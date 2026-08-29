// The start-up sequence: the work the app does before its first screen. Every step names itself on
// screen the moment it begins and lands with its tail; the boot screen in src/App.tsx shows the
// lines as they stand.

import { restoreInstrument } from "@/audio/instrument";
import { restoreRoles } from "@/audio/roles";
import { getDb, readSettings, type Settings } from "@/db/db";
import { reasonOf } from "@/library/notice";
import { scanLibrary } from "@/library/scan";
import { setTheme } from "@/look/use-dark";
import { invoke } from "@tauri-apps/api/core";

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

/** Why a call failed, or an empty string when it did not. */
async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "";
  } catch (error) {
    return reasonOf(error);
  }
}

/**
 * Runs the start-up steps in order, reporting the log after every print, and resolves with the
 * settings the app routes on. A step that fails shows its reason and the steps after it still run,
 * so a database that will not open lands on onboarding with the reason on screen.
 */
export async function boot(
  print: (lines: BootLine[]) => void,
): Promise<Settings> {
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
  const opened = await step("opening database", getDb);
  const settings = await readSettings();
  if (opened) say({ label: "reading settings", state: "ok" });
  setTheme(settings.theme);
  say({ label: `theme: ${settings.theme}`, state: "note" });

  await step("starting sound engine", async () => {
    await invoke("audio_start");
    // Every setting is applied whatever the one before it did: a device that has been unplugged
    // must not cost the app its effect chain. Only the start itself stops the rest, because
    // nothing can be applied to an engine that is not there.
    const reasons = [
      await failure(() =>
        invoke("audio_set_output_device", { id: settings.audio_output_device }),
      ),
      await failure(() =>
        invoke("audio_set_buffer_frames", {
          frames: settings.audio_buffer_frames,
        }),
      ),
      await failure(() =>
        invoke("audio_set_sample_rate", { rate: settings.audio_sample_rate }),
      ),
      // Before the instrument goes in, so its streaming rings are allocated at this count.
      await failure(() =>
        invoke("audio_set_voices", { count: settings.audio_voices }),
      ),
      await failure(() =>
        invoke("audio_set_chain", { chain: settings.effect_chain }),
      ),
      await failure(() =>
        invoke("audio_set_keyboard_volume", {
          percent: settings.keyboard_volume,
        }),
      ),
      await failure(() =>
        invoke("audio_set_velocity_curve", {
          min: settings.velocity_min,
          max: settings.velocity_max,
          curve: settings.velocity_curve,
        }),
      ),
    ];
    const first = reasons.find(Boolean);
    if (first) throw new Error(first);
  });

  await step("restoring instrument", async () => {
    // Both go in whatever the other did, as in the engine step; the roles ride on the loaded
    // instrument, so the restore goes first. The landed line names the instrument that went in,
    // when the engine's list knew it.
    const [name, reason] = await restoreInstrument(settings).then(
      (restored) => [restored, ""] as const,
      (error: unknown) => [null, reasonOf(error)] as const,
    );
    const roles = await failure(() => restoreRoles(settings.instrument_id));
    const first = reason || roles;
    if (first) throw new Error(first);
    return name ? `restoring ${name}` : undefined;
  });

  // The library screen walks the same folder on mount, and `scanLibrary` walks a folder once, so
  // the wait for it happens here instead of behind an empty list.
  if (settings.onboarding_done && settings.library_folder) {
    await step(`scanning ${settings.library_folder}`, () =>
      scanLibrary(settings.library_folder),
    );
  }
  return settings;
}
