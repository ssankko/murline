// The status bar: the last row of the library, the Preview and the play screen. On the left it
// says what the app is listening to and what it is playing through, each cell the button its
// popover hangs from; on the right it says what the sound engine costs, and holds the way into the
// settings panel.

import type { EffectSlot } from '@/audio/effects';
import { Mixer } from '@/audio/mixer';
import { NO_STATUS, type AudioStatus } from '@/audio/sound-tab';
import { MidiLight } from '@/midi/midi-light';
import { useMidiStatus } from '@/midi/use-midi-status';
import type { SettingChange } from '@/screens/settings';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { AudioLines, Cpu, SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** How the dot beside a cell reads: working, nothing there, or something wrong. */
export type Dot = 'on' | 'off' | 'bad';

/** The load past which the number turns red: the render block is close to missing its buffer. */
export const HOT = 80;

/** How often the sound line is read again, in milliseconds. */
const READ_MS = 2000;

/** What the render block last reported about itself. */
interface Meter {
  voices: number;
  load: number;
}

/** Green while a keyboard is listened to, red when MIDI itself is unreachable. */
export function midiDot(devices: string[], error: string | null): Dot {
  if (error) return 'bad';
  return devices.length ? 'on' : 'off';
}

/** Green while an instrument is playing, red when the sound cannot come out as it was asked to. */
export function audioDot(status: AudioStatus | null): Dot {
  if (!status) return 'off';
  if (!status.available || status.fallback) return 'bad';
  return status.instrument ? 'on' : 'off';
}

/** The sound the app makes, in the order it is made: the instrument, then every effect after it. */
export function soundLabel(status: AudioStatus | null, chain: EffectSlot[]): string {
  if (status && !status.available) return status.reason || 'No sound';
  const parts = [status?.instrument || 'No instrument', ...chain.map((slot) => slot.name)];
  return parts.filter(Boolean).join(' → ');
}

/**
 * Whether a key press is the shortcut that opens the settings panel. A text field owns its own
 * commas, and a dialog already over the screen owns every key while it stands.
 */
export function opensSettings(event: KeyboardEvent, dialogOpen: boolean): boolean {
  if (!event.metaKey || event.key !== ',') return false;
  if (dialogOpen) return false;
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  return tag !== 'INPUT' && tag !== 'TEXTAREA' && !target?.isContentEditable;
}

export function StatusBar({
  midiOpen,
  onMidiOpen,
  mixerOpen,
  onMixerOpen,
  onOpenSettings,
  onSoundSettings,
  onGlobalChange,
}: {
  /** The two popovers are opened from the settings panel's search as well, so the screen holds
   * whether they are open and the bar is only where they hang. */
  midiOpen: boolean;
  onMidiOpen: (open: boolean) => void;
  mixerOpen: boolean;
  onMixerOpen: (open: boolean) => void;
  onOpenSettings: () => void;
  /** The mixer's way into the Sound tab, which the screen opens the panel for. */
  onSoundSettings: () => void;
  onGlobalChange?: (...change: SettingChange) => void;
}) {
  const { devices, error } = useMidiStatus();
  const [engine, setEngine] = useState<{ status: AudioStatus | null; chain: EffectSlot[] }>({
    status: null,
    chain: [],
  });
  const [meter, setMeter] = useState<Meter | null>(null);

  // A new instrument and an edited chain raise no event, so the line is read again on a timer as
  // well as at every change of the device list.
  // ponytail: polling stands in for the `audio-changed` event the engine does not send.
  useEffect(() => {
    let live = true;
    const read = async () => {
      const [status, chain] = await Promise.all([
        invoke<AudioStatus>('audio_status').catch(() => NO_STATUS),
        invoke<EffectSlot[]>('audio_chain').catch(() => []),
      ]);
      if (live) setEngine({ status, chain });
    };
    void read();
    const timer = setInterval(() => void read(), READ_MS);
    const listening = listen('audio-devices-changed', () => void read()).catch(() => () => {});
    return () => {
      live = false;
      clearInterval(timer);
      void listening.then((stop) => stop());
    };
  }, []);

  // Four a second while a graph is playing, and nothing at all while there is none.
  useEffect(() => {
    const listening = listen<Meter>('audio-load', ({ payload }) => setMeter(payload)).catch(
      () => () => {},
    );
    return () => void listening.then((stop) => stop());
  }, []);

  const settings = useRef(onOpenSettings);
  settings.current = onOpenSettings;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const dialog = document.querySelector('[role="dialog"][data-state="open"]') !== null;
      if (!opensSettings(event, dialog)) return;
      event.preventDefault();
      settings.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { status, chain } = engine;
  // Without an engine there is nothing to count, so both meters stand at a dash.
  const shown = status?.available ? meter : null;
  const midiLabel = error ?? (devices.length ? devices.join(', ') : 'No MIDI device');

  return (
    <div className="bg-chrome border-edge-soft flex h-[22px] flex-none items-center gap-1 border-t px-2 text-[11px]">
      <MidiLight
        open={midiOpen}
        onOpenChange={onMidiOpen}
        trigger={<Cell label="MIDI devices" dot={midiDot(devices, error)} text={midiLabel} />}
      />
      <Mixer
        open={mixerOpen}
        onOpenChange={onMixerOpen}
        onSoundSettings={onSoundSettings}
        onGlobalChange={onGlobalChange}
        trigger={
          <Cell label="Sound" dot={audioDot(status)} text={soundLabel(status, chain)} />
        }
      />

      <div className="text-muted-ink ml-auto flex flex-none items-center gap-2">
        <span className="flex items-center gap-1" title="Voices sounding">
          <AudioLines size={12} strokeWidth={1.75} />
          <span className="tabular-nums">{shown ? shown.voices : '—'}</span>
        </span>
        <span
          className="flex items-center gap-1"
          title="Render load: the share of its time the sound engine takes"
        >
          <Cpu size={12} strokeWidth={1.75} />
          <span
            className={`tabular-nums ${shown && shown.load > HOT ? 'text-red-600 dark:text-red-400' : ''}`}
          >
            {shown ? `${shown.load} %` : '—'}
          </span>
        </span>
        <button
          aria-label="Settings"
          title="Settings (⌘,)"
          onClick={onOpenSettings}
          className="hover:bg-ink/8 hover:text-ink flex size-[18px] flex-none items-center justify-center rounded-sm transition-colors duration-150"
        >
          <SlidersHorizontal size={12} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

/** One dot: full ink is not enough to tell three states apart, so this is the one place with hue. */
function Light({ dot }: { dot: Dot }) {
  const paint = {
    on: 'bg-green-600 dark:bg-green-500',
    off: 'bg-muted-ink',
    bad: 'bg-red-600 dark:bg-red-400',
  }[dot];
  return <i data-dot={dot} className={`size-1.5 flex-none rounded-full ${paint}`} />;
}

/**
 * One cell of the left group: a dot, a line of text, and the whole of it the button its popover
 * hangs from. The bar is one row high, so a long line is cut off and the title carries it whole.
 */
function Cell({
  label,
  dot,
  text,
  ...rest
}: { label: string; dot: Dot; text: string } & React.ComponentProps<'button'>) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={text}
      className="hover:bg-ink/8 flex h-[18px] max-w-[280px] min-w-0 items-center gap-1.5 rounded-sm px-1.5 transition-colors duration-150"
    >
      <Light dot={dot} />
      <span className="truncate">{text}</span>
    </button>
  );
}
