// The settings panel's Sound tab: the one global place for the sound engine. Its sections live in
// files of their own; this file holds the tab, the sections the status bar's sound popover shares
// with it, the status line, and the reader that fills it.

import { EffectsSection } from '@/audio/effects';
import { EnvelopeSection } from '@/audio/envelope';
import { InstrumentSection } from '@/audio/instrument';
import { OutputSection } from '@/audio/output';
import { RolesSection, type Role } from '@/audio/roles';
import { sounded, type Sounding } from '@/audio/sounding';
import { VelocitySection } from '@/audio/velocity';
import { getSettingOr } from '@/db/db';
import { useMidiStatus } from '@/midi/use-midi-status';
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
  /** What is playing now; empty when nothing is loaded, which `reason` then explains. */
  instrument: string;
  /** Why the device playing is not the one chosen; empty while the choice is honoured. */
  fallback: string;
  buffer_frames: number;
  sample_rate: number;
  /** What the device reports the buffer costs, in milliseconds. */
  latency_ms: number;
  /** The roles beyond the tone the loaded instrument offers; empty for a plugin or a plain file. */
  roles: Role[];
}

/** A status with nothing in it, which is what an engine that cannot even be asked answers. */
export const NO_STATUS: AudioStatus = {
  available: false,
  reason: '',
  device: null,
  device_name: '',
  instrument: '',
  fallback: '',
  buffer_frames: 0,
  sample_rate: 0,
  latency_ms: 0,
  roles: [],
};

/** The one line the tab says about the engine: why there is no sound at all, or where the sound
 * had to go when the chosen device was not there. Never both, because silence is the bigger thing
 * to say and a fallen-back engine is still playing. */
function trouble(status: AudioStatus | null): string {
  if (!status) return '';
  return status.available ? status.fallback : status.reason;
}

/**
 * What the engine says about itself, re-read whenever the device list changes. `round` is a
 * counter a caller bumps when it has just changed something the answer depends on, such as the
 * instrument. Null until the first answer lands.
 */
export function useAudioStatus(round = 0): AudioStatus | null {
  const [status, setStatus] = useState<AudioStatus | null>(null);

  useEffect(() => {
    let live = true;
    const read = () =>
      invoke<AudioStatus>('audio_status').then(
        (answer) => live && setStatus(answer),
        (error: unknown) => live && setStatus({ ...NO_STATUS, reason: String(error) }),
      );
    void read();
    // Unplugging the chosen device is the other way the answer changes while nothing is touched.
    const listening = listen('audio-devices-changed', () => void read());
    return () => {
      live = false;
      void listening.then((stop) => stop());
    };
  }, [round]);

  return status;
}

/**
 * What makes and shapes the sound: the instrument, its roles, the touch, the envelope and the
 * effect chain. Shared whole by the Sound tab and the status bar's sound popover. The sections come
 * out as a fragment, so whichever holds them sets the space between them. `marked` is the row a
 * search result jumped to, handed down so each section can mark its own.
 */
export function SoundControls({
  marked,
  folder = true,
  onChanged,
}: {
  marked?: string | null;
  /** The instruments folder row, which the sound popover leaves out. */
  folder?: boolean;
  /** A new instrument, for whatever reads the sound line outside these sections. */
  onChanged?: () => void;
}) {
  // A section that changed something another one reads asks for this to go round again.
  const [round, setRound] = useState(0);
  const status = useAudioStatus(round);
  const [instrument, setInstrument] = useState<string | null>(null);
  const sounding = useSounding();

  // The envelope and the roles are kept under the instrument's id, so this has to know which one
  // is playing.
  useEffect(() => {
    let live = true;
    getSettingOr('instrument_id').then((id) => live && setInstrument(id), console.error);
    return () => {
      live = false;
    };
  }, [round]);

  return (
    <>
      <InstrumentSection
        marked={marked}
        folder={folder}
        onChanged={() => {
          setRound((round) => round + 1);
          onChanged?.();
        }}
      />
      <RolesSection
        marked={marked}
        roles={status?.roles}
        instrument={instrument}
        round={round}
      />
      <VelocitySection marked={marked} sounding={sounding.keys} />
      <EnvelopeSection
        marked={marked}
        sounding={sounding.keys}
        onRelease={sounding.dieAfter}
        instrument={instrument}
        round={round}
      />
      <EffectsSection marked={marked} />
    </>
  );
}

/**
 * The sound engine's own settings, under the panel's Sound tab: where the sound goes out, what
 * makes it, and the one line saying what is wrong with it.
 */
export function SoundTab({ marked }: { marked?: string | null }) {
  // The trouble line follows the instrument, which only the sections below can change.
  const [round, setRound] = useState(0);
  const status = useAudioStatus(round);

  return (
    <div className="flex min-w-0 flex-col gap-7">
      <OutputSection marked={marked} />
      <SoundControls marked={marked} onChanged={() => setRound((round) => round + 1)} />
      {trouble(status) && <p className="text-muted-ink text-[12px]">{trouble(status)}</p>}
    </div>
  );
}

/** How long a key that has come up is drawn for while no envelope has said, in seconds. */
const DYING = 1;

/**
 * Every key under the hands, for the two plots that mark them. The tab is only here while the
 * panel is open, so nothing is counted while it is shut.
 *
 * A key that has come up is dropped once it has died away, which is the envelope's release, so the
 * two plots let go of it together rather than the touch plot holding a dot the envelope has
 * already finished with. `dieAfter` is how the envelope section says what its release is now.
 */
function useSounding(): { keys: Sounding[]; dieAfter: (seconds: number) => void } {
  const [keys, setKeys] = useState<Sounding[]>([]);
  const [dying, setDying] = useState(DYING);

  useMidiStatus((event) => {
    const at = performance.now();
    setKeys((all) => sounded(all, event, at));
    if (event.on) return;
    setTimeout(
      () => setKeys((all) => all.filter((one) => one.midi !== event.midi || one.on)),
      dying * 1000,
    );
  });

  return { keys, dieAfter: setDying };
}
