// The Audio dialog's Output section: the output device, the buffer size and the latency they cost.
// Both are global settings written on change and applied again at boot. The list follows the
// hardware: the engine sends `audio-devices-changed` on every plug and unplug, and this reads it
// again, so an interface appears and disappears without a restart.

import type { AudioStatus } from '@/audio/dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getSettingOr, setSetting } from '@/db/db';
import { reasonOf } from '@/library/notice';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

/** One device the engine can play through: an opaque id and the name to show. */
export interface OutputDevice {
  id: string;
  name: string;
}

/** The buffer sizes the engine takes, smallest first. */
const FRAME_CHOICES = [32, 64, 128, 256];

export function OutputSection() {
  const [devices, setDevices] = useState<OutputDevice[]>([]);
  const [status, setStatus] = useState<AudioStatus | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [frames, setFrames] = useState(64);
  /** What went wrong with the last change, shown until the next one works. */
  const [failure, setFailure] = useState('');

  const readEngine = useCallback(async () => {
    const [list, answer] = await Promise.all([
      invoke<OutputDevice[]>('audio_output_devices'),
      invoke<AudioStatus>('audio_status'),
    ]);
    setDevices(list);
    setStatus(answer);
  }, []);

  useEffect(() => {
    void getSettingOr('audio_output_device').then(setChosen);
    void getSettingOr('audio_buffer_frames').then(setFrames);
  }, []);

  useEffect(() => {
    void readEngine();
    const listening = listen('audio-devices-changed', () => void readEngine());
    return () => {
      void listening.then((stop) => stop());
    };
  }, [readEngine]);

  /** Writes the setting, applies it to the engine, and reads back what the device now reports. */
  const change = async (write: () => Promise<void>, apply: () => Promise<unknown>) => {
    await write();
    try {
      await apply();
      setFailure('');
    } catch (error) {
      setFailure(reasonOf(error));
    }
    await readEngine();
  };

  const chooseDevice = (id: string | null) =>
    change(
      async () => {
        setChosen(id);
        await setSetting('audio_output_device', id);
      },
      () => invoke('audio_set_output_device', { id }),
    );

  const chooseFrames = (choice: number) =>
    change(
      async () => {
        setFrames(choice);
        await setSetting('audio_buffer_frames', choice);
      },
      () => invoke('audio_set_buffer_frames', { frames: choice }),
    );

  // The picker shows the choice, even while the device it names is unplugged; the line under the
  // rows is what says the engine had to play somewhere else.
  const chosenName =
    chosen === null ? 'System default' : (devices.find((d) => d.id === chosen)?.name ?? chosen);
  const note = failure || status?.fallback || '';

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Output</h3>

      <Row label="Device">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label="Output device"
              className="h-7 max-w-[220px] justify-between px-2 text-[12px] font-normal"
            >
              <span className="truncate">{chosenName}</span>
              <ChevronDown className="size-3.5 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-[280px]">
            <DropdownMenuRadioGroup
              value={chosen ?? ''}
              onValueChange={(id) => void chooseDevice(id || null)}
            >
              <DropdownMenuRadioItem value="" className="text-[13px]">
                System default
              </DropdownMenuRadioItem>
              {devices.map((device) => (
                <DropdownMenuRadioItem key={device.id} value={device.id} className="text-[13px]">
                  <span className="truncate">{device.name}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>

      <Row label="Buffer">
        <div className="border-edge flex flex-none border">
          {FRAME_CHOICES.map((choice) => (
            <button
              key={choice}
              aria-pressed={frames === choice}
              onClick={() => void chooseFrames(choice)}
              className={`h-6 px-2 text-[11.5px] font-medium tabular-nums transition-colors duration-150 ${
                frames === choice ? 'bg-ink text-paper' : 'hover:bg-ink/8'
              }`}
            >
              {choice}
            </button>
          ))}
        </div>
      </Row>

      <Row label="Latency">
        <span className="text-muted-ink text-[12px] tabular-nums">{latencyLine(status)}</span>
      </Row>

      {note && <p className="text-muted-ink text-[12px]">{note}</p>}
    </section>
  );
}

/** What the device reports the buffer costs, at the rate it runs, which the app never sets. */
function latencyLine(status: AudioStatus | null): string {
  if (!status?.latency_ms) return '—';
  return `${status.latency_ms.toFixed(1)} ms at ${(status.sample_rate / 1000).toFixed(1)} kHz`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 py-1 text-[12px]">
      <span className="flex-none">{label}</span>
      {children}
    </div>
  );
}
