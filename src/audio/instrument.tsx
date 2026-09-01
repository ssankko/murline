// The Sound tab's Instrument section: the instrument the keyboard and the Preview play. The
// engine finds them, this picks one, and every control writes its setting on change.

import { numbered, Row, Segmented } from "@/look/rows";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { reasonOf } from "@/library/notice";
import { Loading } from "@/look/loading";
import { call, type AudioStatus, type Instrument } from "@/rust";
import { set, setting, useSetting } from "@/settings/settings";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown } from "lucide-react";
import { Fragment, useEffect, useState } from "react";

/** The sample rates the engine renders at, in Hz. Each voice costs in proportion. */
const RATE_CHOICES = [44100, 48000, 88200, 96000];

/**
 * The rates that can be picked now: never above the rate the loaded file was recorded at, because
 * rendering a sampled instrument over its own rate buys nothing but load. A plugin, which has no
 * recorded rate, takes any.
 */
function allowedRates(status: AudioStatus | null): number[] {
  const ceiling = status?.instrument_rate ?? 0;
  return ceiling > 0
    ? RATE_CHOICES.filter((rate) => rate <= ceiling)
    : RATE_CHOICES;
}

/** Logic's piano, which the app plays until the user picks something else. */
const DEFAULT_NAME = "Concert Grand Piano";

function listInstruments(folder: string): Promise<Instrument[]> {
  return call("audio_instruments", { folder });
}

/**
 * Puts the chosen instrument back into the engine at boot, choosing Logic's Concert Grand the
 * first time, and answers with its name, or null when there was none to put back. A choice the
 * engine can no longer find still goes in, so its reason reaches the status line instead of
 * silence with no explanation.
 */
export async function restoreInstrument(): Promise<string | null> {
  const kept = setting("instrument_id");
  // The empty id is the instrument taken out on purpose, so nothing goes back in; null is a first
  // launch, which gets the default below.
  if (kept === "") return null;
  const all = await listInstruments(setting("instruments_folder"));
  const chosen = kept ?? all.find((one) => one.name === DEFAULT_NAME)?.id ?? null;
  if (!chosen) return null;
  if (chosen !== kept) {
    // The stored state belongs to the stored instrument, so a fresh default starts at its own.
    await set("instrument_id", chosen);
    await set("instrument_state", null);
  }
  await call("audio_load_instrument", { id: chosen });
  return all.find((one) => one.id === chosen)?.name ?? null;
}

export function InstrumentSection({
  marked,
  folder: showFolder = true,
  onChanged,
}: {
  marked?: string | null | undefined;
  /** The instruments folder row, which the status bar's sound popover leaves out. */
  folder?: boolean;
  onChanged?: (() => void) | undefined;
}) {
  const [all, setAll] = useState<Instrument[]>([]);
  const chosen = useSetting("instrument_id") ?? "";
  const folder = useSetting("instruments_folder");
  const [failure, setFailure] = useState("");
  const [loading, setLoading] = useState(false);
  const rate = useSetting("audio_sample_rate");
  /** The engine's answer after the last load, for the rate the instrument was recorded at. */
  const [status, setStatus] = useState<AudioStatus | null>(null);

  const readEngine = () =>
    call("audio_status").then(setStatus, console.error);

  useEffect(() => {
    void readEngine();
    let live = true;
    listInstruments(folder)
      .then((found) => {
        if (!live) return;
        setAll(found);
        setFailure(found.find((one) => one.id === chosen)?.reason ?? "");
      })
      .catch((error: unknown) => live && setFailure(reasonOf(error)));
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);

  // The rate must never sit above the instrument's own, so an instrument recorded lower than the
  // rate in force drags it down to the highest rate it and the device both take.
  useEffect(() => {
    if (!status?.instrument_rate || rate <= status.instrument_rate) return;
    const top = allowedRates(status).at(-1);
    if (top && top !== rate) void chooseRate(top);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [status, rate]);

  /**
   * A new instrument: the setting first, since the engine reads what is kept for it, then the
   * load, whose reason is what the picker says and whose answer is what the rows read. A Logic
   * piano takes seconds to load, so the picker beats until the engine answers. The empty id is
   * None, which takes the instrument out instead.
   */
  async function choose(id: string): Promise<void> {
    setFailure("");
    setLoading(true);
    await set("instrument_id", id);
    await set("instrument_state", null);
    try {
      setStatus(
        id
          ? await call("audio_load_instrument", { id })
          : await call("audio_unload_instrument"),
      );
    } catch (error) {
      setFailure(reasonOf(error));
      await readEngine();
    } finally {
      setLoading(false);
    }
    onChanged?.();
  }

  /** A new rate: the engine builds its voice engine anew at it and puts the instrument back. */
  async function chooseRate(choice: number): Promise<void> {
    const reason = await set("audio_sample_rate", choice);
    setFailure(reason);
    await readEngine();
    onChanged?.();
  }

  async function chooseFolder(): Promise<void> {
    const picked = await open({ directory: true, ...(folder ? { defaultPath: folder } : {}) });
    if (typeof picked !== "string") return;
    // The list follows the folder: the effect above reads it again.
    await set("instruments_folder", picked);
  }

  /** The plugin's own window, which hands back the state it was left in when the user closes it. */
  async function show(): Promise<void> {
    const state = await call("audio_show_instrument");
    await set("instrument_state", state);
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
                // The button ships with `shrink-0`; here it must give way, so a long instrument
                // name narrows the trigger instead of pushing Show out of the row.
                className="h-7 max-w-[190px] min-w-0 shrink justify-between px-2 text-[12px] font-normal"
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
                <DropdownMenuRadioItem value="" className="text-[13px]">
                  None
                </DropdownMenuRadioItem>
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

      <Row label="Recommended sample rate">
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
function recordedLine(status: AudioStatus | null): string {
  if (!status?.instrument) return "—";
  if (!status.instrument_rate)
    return "any: a plugin renders at the rate it is given";
  return `${(status.instrument_rate / 1000).toFixed(1)} kHz, the rate it was recorded at`;
}
