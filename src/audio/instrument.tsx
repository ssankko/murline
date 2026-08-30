// The Sound tab's Instrument section: the instrument the keyboard and the Preview play. The
// engine finds them, this picks one, and every control writes its setting on change.

import { restoreEnvelope } from "@/audio/envelope";
import { numbered, Row, Segmented } from "@/look/rows";
import { restoreRoles } from "@/audio/roles";
import type { AudioStatus } from "@/audio/sound-tab";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getSettingOr, readSettings, setSetting, type Settings } from "@/db/db";
import { reasonOf } from "@/library/notice";
import { Loading } from "@/look/loading";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

/** One line of the picker. The id is opaque; only the engine knows what it names. */
export interface Instrument {
  id: string;
  name: string;
  /** `file` for one the engine's sampler loads, `plugin` for a hosted Audio Unit. */
  kind: string;
  loaded: boolean;
  /** Why this instrument is silent, when it is the chosen one and its load failed. */
  reason: string;
}

/** The sample rates the engine renders at, in Hz. Each voice costs in proportion. */
const RATE_CHOICES = [44100, 48000, 88200, 96000];

/**
 * The rates that can be picked now: never above the rate the loaded file was recorded at, because
 * rendering a sampled instrument over its own rate buys nothing but load. A plugin, which has no
 * recorded rate, takes any.
 */
export function allowedRates(status: AudioStatus | null): number[] {
  const ceiling = status?.instrument_rate ?? 0;
  return ceiling > 0
    ? RATE_CHOICES.filter((rate) => rate <= ceiling)
    : RATE_CHOICES;
}

/** Logic's piano, which the app plays until the user picks something else. */
const DEFAULT_NAME = "Concert Grand Piano";

function listInstruments(folder: string): Promise<Instrument[]> {
  return invoke<Instrument[]>("audio_instruments", { folder });
}

/**
 * Puts the chosen instrument back into the engine at boot, choosing Logic's Concert Grand the
 * first time, and answers with its name, or null when there was none to put back. A choice the
 * engine can no longer find still goes in, so its reason reaches the status line instead of
 * silence with no explanation.
 */
export async function restoreInstrument(
  settings: Settings,
): Promise<string | null> {
  const all = await listInstruments(settings.instruments_folder);
  const chosen =
    settings.instrument_id ??
    all.find((one) => one.name === DEFAULT_NAME)?.id ??
    null;
  if (!chosen) return null;
  if (chosen !== settings.instrument_id)
    await setSetting("instrument_id", chosen);
  // The stored state belongs to the stored instrument, so a fresh default starts at its own.
  const state =
    chosen === settings.instrument_id ? settings.instrument_state : null;
  await invoke("audio_load_instrument", { id: chosen, state });
  await restoreEnvelope(chosen);
  return all.find((one) => one.id === chosen)?.name ?? null;
}

export function InstrumentSection({
  marked,
  folder: showFolder = true,
  onChanged,
}: {
  marked?: string | null;
  /** The instruments folder row, which the status bar's sound popover leaves out. */
  folder?: boolean;
  onChanged?: () => void;
}) {
  const [all, setAll] = useState<Instrument[]>([]);
  const [chosen, setChosen] = useState<string>("");
  const [folder, setFolder] = useState("");
  const [failure, setFailure] = useState("");
  const [loading, setLoading] = useState(false);
  const [rate, setRate] = useState(44100);
  /** The engine's answer after the last load, for the rate the instrument was recorded at. */
  const [status, setStatus] = useState<AudioStatus | null>(null);

  const readEngine = () =>
    invoke<AudioStatus>("audio_status").then(setStatus, console.error);

  useEffect(() => {
    void getSettingOr("audio_sample_rate").then(setRate);
    void readEngine();
  }, []);

  useEffect(() => {
    let live = true;
    readSettings()
      .then(async (settings) => {
        const found = await listInstruments(settings.instruments_folder);
        if (!live) return;
        setFolder(settings.instruments_folder);
        setChosen(settings.instrument_id ?? "");
        setAll(found);
        setFailure(
          found.find((one) => one.id === settings.instrument_id)?.reason ?? "",
        );
      })
      .catch((error: unknown) => live && setFailure(reasonOf(error)));
    return () => {
      live = false;
    };
  }, []);

  // The rate must never sit above the instrument's own, so an instrument recorded lower than the
  // rate in force drags it down to the highest rate it and the device both take.
  useEffect(() => {
    if (!status?.instrument_rate || rate <= status.instrument_rate) return;
    const top = allowedRates(status).at(-1);
    if (top && top !== rate) void chooseRate(top);
  }, [status, rate]);

  /**
   * A new instrument: the setting first, then the load, whose reason is what the picker says. A
   * Logic piano takes seconds to load, so the picker beats until the engine answers.
   */
  async function choose(id: string): Promise<void> {
    setChosen(id);
    setFailure("");
    setLoading(true);
    await setSetting("instrument_id", id);
    await setSetting("instrument_state", null);
    try {
      await invoke("audio_load_instrument", { id, state: null });
      await restoreEnvelope(id);
    } catch (error) {
      setFailure(reasonOf(error));
    } finally {
      setLoading(false);
    }
    await readEngine();
    onChanged?.();
  }

  /**
   * A new rate: the voice engine is built anew at it, so the instrument goes in again, and the
   * envelope and the levels ride back in on the restore.
   */
  async function chooseRate(choice: number): Promise<void> {
    setRate(choice);
    await setSetting("audio_sample_rate", choice);
    try {
      await invoke("audio_set_sample_rate", { rate: choice });
      const settings = await readSettings();
      await restoreInstrument(settings);
      await restoreRoles(settings.instrument_id);
      setFailure("");
    } catch (error) {
      setFailure(reasonOf(error));
    }
    await readEngine();
    onChanged?.();
  }

  async function chooseFolder(): Promise<void> {
    const picked = await open({
      directory: true,
      defaultPath: folder || undefined,
    });
    if (typeof picked !== "string") return;
    await setSetting("instruments_folder", picked);
    setFolder(picked);
    setAll(await listInstruments(picked));
  }

  /** The plugin's own window, which hands back the state it was left in when the user closes it. */
  async function show(): Promise<void> {
    const state = await invoke<string | null>("audio_show_instrument");
    await setSetting("instrument_state", state);
  }

  const shown = all.find((one) => one.id === chosen);
  const plugin = shown?.kind === "plugin";

  /** One heading and the instruments under it, left out while the engine found none of that kind. */
  const group = (heading: string, ones: Instrument[]) =>
    ones.length > 0 && (
      <Fragment key={heading}>
        <DropdownMenuLabel className="text-muted-ink px-2 py-1 text-[11px]">
          {heading}
        </DropdownMenuLabel>
        {ones.map((one) => (
          <DropdownMenuRadioItem
            key={one.id}
            value={one.id}
            className="text-[13px]"
          >
            <span className="truncate">{one.name}</span>
          </DropdownMenuRadioItem>
        ))}
      </Fragment>
    );

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Instrument</h3>

      <Row
        id="instrument_id"
        marked={marked === "instrument_id"}
        label="Instrument"
        hint="What the keyboard and the Preview play."
      >
        <div className="flex min-w-0 items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                aria-label="Instrument"
                className="h-7 max-w-[190px] justify-between px-2 text-[12px] font-normal"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{shown?.name ?? "None"}</span>
                  <Loading on={loading} label="Loading the instrument" />
                </span>
                <ChevronDown className="size-3.5 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-w-[280px]">
              {all.length === 0 && (
                <DropdownMenuLabel className="text-muted-ink px-2 py-1 text-[11px]">
                  No instrument found
                </DropdownMenuLabel>
              )}
              <DropdownMenuRadioGroup
                value={chosen}
                onValueChange={(id) => void choose(id)}
              >
                {group(
                  "Audio Unit instruments",
                  all.filter((one) => one.kind === "plugin"),
                )}
                {group(
                  "Files",
                  all.filter((one) => one.kind !== "plugin"),
                )}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {plugin && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 flex-none"
              onClick={() => void show()}
            >
              Show
            </Button>
          )}
        </div>
      </Row>

      <Row
        label="Recommended sample rate"
        hint="The rate this instrument was recorded at."
      >
        <span className="text-muted-ink text-[12px] tabular-nums">
          {recordedLine(status)}
        </span>
      </Row>

      <Row
        id="audio_sample_rate"
        marked={marked === "audio_sample_rate"}
        label="Sample rate (Hz)"
        hint="Higher costs render load: 96 kHz is twice 48 kHz."
      >
        <Segmented
          options={numbered(RATE_CHOICES)}
          value={rate}
          allowed={allowedRates(status)}
          onChange={(choice) => void chooseRate(choice)}
        />
      </Row>

      {failure && <p className="text-muted-ink text-[12px]">{failure}</p>}

      {showFolder && (
        <Row
          id="instruments_folder"
          marked={marked === "instruments_folder"}
          label="Instruments folder"
          hint="Every .sf2 and .exs file in it is listed above."
        >
          <div className="flex min-w-0 items-center gap-2">
            <code className="text-muted-ink truncate text-[11.5px] select-text">
              {folder || "not set"}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="h-7 flex-none"
              onClick={() => void chooseFolder()}
            >
              Choose…
            </Button>
          </div>
        </Row>
      )}
    </section>
  );
}

/** The rate the loaded file was recorded at, which is the one that plays it without resampling;
 * a plugin renders at whatever rate it is given. */
export function recordedLine(status: AudioStatus | null): string {
  if (!status?.instrument) return "—";
  if (!status.instrument_rate)
    return "any: a plugin renders at the rate it is given";
  return `${(status.instrument_rate / 1000).toFixed(1)} kHz, the rate it was recorded at`;
}
