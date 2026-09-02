// The Sound tab's Output section: the output device, the buffer size, the voices the engine may
// hold sounding at once, and the latency the buffer costs. Every choice is a global setting
// written on change and applied again at boot. The device list follows the hardware: the engine
// sends `audio-devices-changed` on every plug and unplug, and this reads it again, so an interface
// appears and disappears without a restart.

import { restoreInstrument } from "@/audio/instrument";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { numbered, Row, Segmented } from "@/look/rows";
import { commands, type AudioStatus, type OutputDevice } from "@/bindings";
import { on } from "@/rust";
import { set, useSetting } from "@/settings/settings";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

/** The buffer sizes the engine takes, smallest first. A device offers a subset of them. */
const FRAME_CHOICES = [32, 64, 128, 256, 512];

/** The voice limits the engine takes. 512 voices cost 256 MB of streaming buffers for an EXS. */
const VOICE_CHOICES = [128, 256, 512];

export function OutputSection() {
  const [devices, setDevices] = useState<OutputDevice[]>([]);
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const chosen = useSetting("audio_output_device");
  const frames = useSetting("audio_buffer_frames");
  const voices = useSetting("audio_voices");
  /** Why the engine would not take the last change, shown until one it takes. */
  const [failure, setFailure] = useState("");

  const readEngine = useCallback(async () => {
    const [list, answer] = await Promise.all([
      commands.audioOutputDevices(),
      commands.audioStatus(),
    ]);
    setDevices(list);
    setStatus(answer);
  }, []);

  useEffect(() => {
    void readEngine();
    return on("audioDevicesChanged", () => void readEngine());
  }, [readEngine]);

  /** Writes the setting, which is what applies it to the engine, and reads the device back. */
  const change = async (write: () => Promise<string>) => {
    setFailure(await write());
    await readEngine();
  };

  const chooseDevice = (id: string | null) => change(() => set("audio_output_device", id));

  const chooseFrames = (choice: number) => change(() => set("audio_buffer_frames", choice));

  const chooseVoices = (choice: number) =>
    change(async () => {
      const reason = await set("audio_voices", choice);
      if (reason) return reason;
      // A sampled instrument's streaming rings are allocated with it, two slots per voice, so it
      // is read again at the new count.
      await restoreInstrument();
      return "";
    });

  // A device that is not connected is not in the list, and the picker names it nowhere. It reads as
  // the system default, where the sound is really going. The setting keeps the choice, so the name
  // comes back with the device, and the tab's own line is what says the engine had to move.
  const shown = devices.find((d) => d.id === chosen);

  // A device that does not take the saved size runs at one of its own, so the row shows that size
  // and its hint says whose it is.
  const running =
    status?.buffer_choices?.length && !status.buffer_choices.includes(frames)
      ? status.buffer_frames
      : frames;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Output</h3>

      <Row
        id="audio_output_device"
      >
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label="Output device"
              // The button ships with `shrink-0`; here it must give way, so a long device name
              // narrows the trigger instead of widening the row.
              className="h-7 max-w-[190px] min-w-0 shrink justify-between px-2 text-[12px] font-normal"
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

      <Row
        id="audio_buffer_frames"
        hint={
          running === frames
            ? "Smaller is quicker; too small crackles."
            : `This device does not take ${frames} frames; running at ${running}.`
        }
      >
        <Segmented
          options={numbered(FRAME_CHOICES)}
          value={running}
          allowed={status?.buffer_choices}
          onChange={(choice) => void chooseFrames(choice)}
        />
      </Row>

      <Row
        id="audio_voices"
        hint="Most notes sounding at once; more costs memory."
      >
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
