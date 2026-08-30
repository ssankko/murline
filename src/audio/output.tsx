// The Sound tab's Output section: the output device, the buffer size, the voices the engine may
// hold sounding at once, and the latency the buffer costs. Every choice is a global setting
// written on change and applied again at boot. The device list follows the hardware: the engine
// sends `audio-devices-changed` on every plug and unplug, and this reads it again, so an interface
// appears and disappears without a restart.

import { restoreInstrument } from "@/audio/instrument";
import { restoreRoles } from "@/audio/roles";
import type { AudioStatus } from "@/audio/sound-tab";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { getSettingOr, readSettings, setSetting } from "@/db/db";
import { reasonOf } from "@/library/notice";
import { numbered, Row, Segmented } from "@/look/rows";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/** One device the engine can play through: an opaque id and the name to show. */
export interface OutputDevice {
  id: string;
  name: string;
}

/** The buffer sizes the engine takes, smallest first. A device offers a subset of them. */
const FRAME_CHOICES = [32, 64, 128, 256, 512];

/** The voice limits the engine takes. 512 voices cost 256 MB of streaming buffers for an EXS. */
const VOICE_CHOICES = [128, 256, 512];

export function OutputSection({ marked }: { marked?: string | null }) {
  const [devices, setDevices] = useState<OutputDevice[]>([]);
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [frames, setFrames] = useState(64);
  const [voices, setVoices] = useState(128);
  /** What went wrong with the last change, shown until the next one works. */
  const [failure, setFailure] = useState("");

  const readEngine = useCallback(async () => {
    const [list, answer] = await Promise.all([
      invoke<OutputDevice[]>("audio_output_devices"),
      invoke<AudioStatus>("audio_status"),
    ]);
    setDevices(list);
    setStatus(answer);
  }, []);

  useEffect(() => {
    void getSettingOr("audio_output_device").then(setChosen);
    void getSettingOr("audio_buffer_frames").then(setFrames);
    void getSettingOr("audio_voices").then(setVoices);
  }, []);

  useEffect(() => {
    void readEngine();
    const listening = listen("audio-devices-changed", () => void readEngine());
    return () => {
      void listening.then((stop) => stop());
    };
  }, [readEngine]);

  /** Writes the setting, applies it to the engine, and reads back what the device now reports. */
  const change = async (
    write: () => Promise<void>,
    apply: () => Promise<unknown>,
  ) => {
    await write();
    try {
      await apply();
      setFailure("");
    } catch (error) {
      setFailure(reasonOf(error));
    }
    await readEngine();
  };

  const chooseDevice = (id: string | null) =>
    change(
      async () => {
        setChosen(id);
        await setSetting("audio_output_device", id);
      },
      () => invoke("audio_set_output_device", { id }),
    );

  const chooseFrames = (choice: number) =>
    change(
      async () => {
        setFrames(choice);
        await setSetting("audio_buffer_frames", choice);
      },
      () => invoke("audio_set_buffer_frames", { frames: choice }),
    );

  const chooseVoices = (choice: number) =>
    change(
      async () => {
        setVoices(choice);
        await setSetting("audio_voices", choice);
      },
      async () => {
        await invoke("audio_set_voices", { count: choice });
        // A sampled instrument's streaming rings are allocated with it, two slots per voice, so it
        // is read again at the new count; the envelope and the levels ride back in on the restore.
        const settings = await readSettings();
        await restoreInstrument(settings);
        await restoreRoles(settings.instrument_id);
      },
    );

  // A device that is not connected is not in the list, and the picker names it nowhere. It reads as
  // the system default, where the sound is really going. The setting keeps the choice, so the name
  // comes back with the device, and the tab's own line is what says the engine had to move.
  const shown = devices.find((d) => d.id === chosen);

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Output</h3>

      <Row
        id="audio_output_device"
        marked={marked === "audio_output_device"}
        label="Output device"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label="Output device"
              className="h-7 max-w-[190px] justify-between px-2 text-[12px] font-normal"
            >
              <span className="truncate">
                {shown?.name ?? "System default"}
              </span>
              <ChevronDown className="size-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-[280px]">
            <DropdownMenuRadioGroup
              value={shown?.id ?? ""}
              onValueChange={(id) => void chooseDevice(id || null)}
            >
              <DropdownMenuRadioItem value="" className="text-[13px]">
                System default
              </DropdownMenuRadioItem>
              {devices.map((device) => (
                <DropdownMenuRadioItem
                  key={device.id}
                  value={device.id}
                  className="text-[13px]"
                >
                  <span className="truncate">{device.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>

      {/* A saved size this device does not take is not the one running, so the row marks the
          size the engine settled on instead. */}
      <Row
        id="audio_buffer_frames"
        marked={marked === "audio_buffer_frames"}
        label="Buffer (frames)"
      >
        <Segmented
          options={numbered(FRAME_CHOICES)}
          value={
            status?.buffer_choices?.includes(frames) === false
              ? status.buffer_frames
              : frames
          }
          allowed={status?.buffer_choices}
          onChange={(choice) => void chooseFrames(choice)}
        />
      </Row>

      <Row id="audio_voices" marked={marked === "audio_voices"} label="Voices">
        <Segmented
          options={numbered(VOICE_CHOICES)}
          value={voices}
          onChange={(choice) => void chooseVoices(choice)}
        />
      </Row>

      <Row label="Latency">
        <span className="text-muted-ink text-[12px] tabular-nums">
          {latencyLine(status)}
        </span>
      </Row>

      {failure && <p className="text-muted-ink text-[12px]">{failure}</p>}
    </section>
  );
}

/** What the device reports the buffer costs, at the rate it runs: the one chosen above when the
 * device took it, else its own. */
function latencyLine(status: AudioStatus | null): string {
  if (!status?.latency_ms) return "—";
  return `${status.latency_ms.toFixed(1)} ms at ${(status.sample_rate / 1000).toFixed(1)} kHz`;
}
