// The settings panel's Sound tab: the one global place for the sound engine. Its three sections
// live in files of their own; this file holds the tab, the status line, and the reader that fills
// it.

import { EffectsSection } from '@/audio/effects';
import { InstrumentSection } from '@/audio/instrument';
import { OutputSection } from '@/audio/output';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useState } from 'react';

/** What the engine answers about itself: whether sound can come out, and why not when it cannot. */
export interface AudioStatus {
  available: boolean;
  reason: string;
  /** Opaque id of the device playing now; null while the engine plays through none. */
  device: string | null;
  device_name: string;
  /** Why the device playing is not the one chosen; empty while the choice is honoured. */
  fallback: string;
  buffer_frames: number;
  sample_rate: number;
  /** What the device reports the buffer costs, in milliseconds. */
  latency_ms: number;
}

/** A status with nothing in it, which is what an engine that cannot even be asked answers. */
export const NO_STATUS: AudioStatus = {
  available: false,
  reason: '',
  device: null,
  device_name: '',
  fallback: '',
  buffer_frames: 0,
  sample_rate: 0,
  latency_ms: 0,
};

/** The one line the tab says about the engine: why there is no sound at all, or where the sound
 * had to go when the chosen device was not there. Never both, because silence is the bigger thing
 * to say and a fallen-back engine is still playing. */
function trouble(status: AudioStatus | null): string {
  if (!status) return '';
  return status.available ? status.fallback : status.reason;
}

/**
 * The sound engine's own settings, under the panel's Sound tab. `marked` is the row a search
 * result jumped to, handed down so each section can mark its own.
 */
export function SoundTab({ marked }: { marked?: string | null }) {
  const [status, setStatus] = useState<AudioStatus | null>(null);
  // A section that changed something the status line reads asks for this to go round again.
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    const read = () =>
      invoke<AudioStatus>('audio_status').then(
        (answer) => live && setStatus(answer),
        (error: unknown) => live && setStatus({ ...NO_STATUS, reason: String(error) }),
      );
    void read();
    // Unplugging the chosen device is the other way the line below changes while the tab is open.
    const listening = listen('audio-devices-changed', () => void read());
    return () => {
      live = false;
      void listening.then((stop) => stop());
    };
  }, [round]);

  return (
    <div className="flex min-w-0 flex-col gap-7">
      <OutputSection marked={marked} />
      <InstrumentSection marked={marked} onChanged={() => setRound((round) => round + 1)} />
      <EffectsSection marked={marked} />
      {trouble(status) && <p className="text-muted-ink text-[12px]">{trouble(status)}</p>}
    </div>
  );
}
