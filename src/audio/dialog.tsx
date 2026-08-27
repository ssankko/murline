// The Audio dialog: the one global place for the sound engine, opened from the play screen and
// from the library. Its three sections live in files of their own; this file holds the box, the
// status line, and the reader that fills it.

import { EffectsSection } from '@/audio/effects';
import { InstrumentSection } from '@/audio/instrument';
import { OutputSection } from '@/audio/output';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { invoke } from '@tauri-apps/api/core';
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

export function AudioDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<AudioStatus | null>(null);
  // A section that changed something the status line reads asks for this to go round again.
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    invoke<AudioStatus>('audio_status').then(
      (answer) => live && setStatus(answer),
      (error: unknown) => live && setStatus({ ...NO_STATUS, reason: String(error) }),
    );
    return () => {
      live = false;
    };
  }, [round]);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">Audio</DialogTitle>
          <DialogDescription className="sr-only">
            The sound engine: output, instrument and effects.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-7">
          <OutputSection />
          <InstrumentSection onChanged={() => setRound((round) => round + 1)} />
          <EffectsSection />
          {status && !status.available && (
            <p className="text-muted-ink text-[12px]">{status.reason}</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
