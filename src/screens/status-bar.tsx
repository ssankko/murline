// The status bar: the last row of the library, the Preview and the play screen. On the left the
// cog into the settings panel and two cells saying what the app is listening to and what it is
// playing through; on the right the volumes, which are the mixer's button, what the sound engine
// costs, and the version cell. The cog and the version cell stand as high as the bar and reach
// into its inset, so a press anywhere near either one lands on it.

import { Mixer, SoundPopover } from '@/audio/mixer';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { MidiLight } from '@/midi/midi-light';
import { useMidiStatus } from '@/midi/use-midi-status';
import {
  call,
  on,
  NO_STATUS,
  type AudioStatus,
  type EffectSlot,
  type Meter,
} from '@/rust';
import { useSetting } from '@/settings/settings';
import { checkUpdate, restartApp, takeUpdate, updateLabel, useVersions } from '@/update';
import { AudioLines, Check, Cpu, Download, Gauge, Metronome, Piano, Settings } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** How the dot beside a cell reads: working, nothing there, or something wrong. */
export type Dot = 'on' | 'off' | 'bad';

/** The load past which the number turns red: the render block is close to missing its buffer. */
export const HOT = 80;

/** How often the sound line is read again, in milliseconds. */
const READ_MS = 2000;

/** One icon size and stroke for the whole bar. */
const ICON = { size: 12, strokeWidth: 1.75 } as const;

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

/** What the latency tooltip says the milliseconds are made of, empty while there is no engine. */
export function latencyLabel(status: AudioStatus | null): string {
  if (!status?.available || !status.sample_rate) return 'Output latency';
  const rate = Number((status.sample_rate / 1000).toFixed(1));
  return `Output latency: ${status.buffer_frames} frames at ${rate} kHz`;
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
}: {
  /** The two popovers are opened from the settings panel's search as well, so the screen holds
   * whether they are open and the bar is only where they hang. */
  midiOpen: boolean;
  onMidiOpen: (open: boolean) => void;
  mixerOpen: boolean;
  onMixerOpen: (open: boolean) => void;
  onOpenSettings: () => void;
  /** The Sound tab at the instrument row, which the link in either popover asks for. */
  onSoundSettings: () => void;
}) {
  const { devices, error } = useMidiStatus();
  const [engine, setEngine] = useState<{ status: AudioStatus | null; chain: EffectSlot[] }>({
    status: null,
    chain: [],
  });
  const [meter, setMeter] = useState<Meter | null>(null);
  const keyboardVolume = useSetting('keyboard_volume');
  const clickVolume = useSetting('click_volume');
  /** The sound popover hangs off the sound cell and nothing else reaches it, so the bar holds it. */
  const [soundOpen, setSoundOpen] = useState(false);

  // A new instrument and an edited chain raise no event, so the line is read again on a timer as
  // well as at every change of the device list. The sound popover asks for a read at once.
  // ponytail: polling stands in for the `audio-changed` event the engine does not send.
  const reread = useRef(() => {});
  useEffect(() => {
    let live = true;
    const read = async () => {
      const [status, chain] = await Promise.all([
        call('audio_status').catch(() => NO_STATUS),
        call('audio_chain').catch(() => []),
      ]);
      if (live) setEngine({ status, chain });
    };
    reread.current = () => void read();
    void read();
    const timer = setInterval(() => void read(), READ_MS);
    const stop = on('audio-devices-changed', () => void read());
    return () => {
      live = false;
      clearInterval(timer);
      stop();
    };
  }, []);

  // Four a second while a graph is playing, and nothing at all while there is none.
  useEffect(() => on('audio-load', setMeter), []);

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
  // Without an engine there is nothing to count, so the meters stand at a dash.
  const shown = status?.available ? meter : null;
  const latency = status?.available ? Math.round(status.latency_ms) : null;
  const midiLabel = error ?? (devices.length ? devices.join(', ') : 'No MIDI device');
  const sound = soundLabel(status, chain);

  return (
    <TooltipProvider>
      <div className="bg-chrome border-edge-soft flex h-[22px] flex-none items-center gap-1 border-t px-2 text-[11px]">
        <Tip text="Settings (⌘,)">
          <button
            aria-label="Settings"
            onClick={onOpenSettings}
            className="text-muted-ink hover:bg-ink/8 hover:text-ink -ml-2 flex h-full flex-none items-center rounded-sm pr-1.5 pl-2 transition-colors duration-150"
          >
            <Settings {...ICON} />
          </button>
        </Tip>

        <Tooltip>
          <MidiLight
            open={midiOpen}
            onOpenChange={onMidiOpen}
            trigger={
              <TooltipTrigger asChild>
                <Cell label="MIDI devices" dot={midiDot(devices, error)} text={midiLabel} />
              </TooltipTrigger>
            }
          />
          <TooltipContent side="top">{midiLabel}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <SoundPopover
            open={soundOpen}
            onOpenChange={setSoundOpen}
            onSoundSettings={onSoundSettings}
            onChanged={() => reread.current()}
            trigger={
              <TooltipTrigger asChild>
                <Cell label="Sound" dot={audioDot(status)} text={sound} />
              </TooltipTrigger>
            }
          />
          <TooltipContent side="top">{sound}</TooltipContent>
        </Tooltip>

        <div className="text-muted-ink ml-auto flex h-full flex-none items-center gap-2 whitespace-nowrap">
          <Mixer
            open={mixerOpen}
            onOpenChange={onMixerOpen}
            onSoundSettings={onSoundSettings}
            trigger={
              <button
                aria-label="Volume"
                className="hover:bg-ink/8 hover:text-ink flex h-[18px] flex-none items-center gap-2 rounded-sm px-1 transition-colors duration-150"
              >
                <Tip text="Keyboard volume">
                  <span className="flex items-center gap-1">
                    <Piano {...ICON} />
                    <span className="min-w-[3ch] tabular-nums">
                      {keyboardVolume}
                    </span>
                  </span>
                </Tip>
                <Tip text="Metronome volume">
                  <span className="flex items-center gap-1">
                    <Metronome {...ICON} />
                    <span className="min-w-[3ch] tabular-nums">
                      {clickVolume}
                    </span>
                  </span>
                </Tip>
              </button>
            }
          />

          <Tip text={latencyLabel(status)}>
            <span className="flex items-center gap-1">
              <Gauge {...ICON} />
              <span className="min-w-[6ch] tabular-nums">
                {latency === null ? '—' : `${latency} ms`}
              </span>
            </span>
          </Tip>

          <Tip text="Voices sounding, of the most the engine holds">
            <span className="flex items-center gap-1">
              <AudioLines {...ICON} />
              <span className="min-w-[7ch] tabular-nums">
                {shown ? `${shown.voices} / ${shown.limit}` : '—'}
              </span>
            </span>
          </Tip>

          <Tip text="Render load: the share of its time the sound engine takes">
            <span className="flex items-center gap-1">
              <Cpu {...ICON} />
              <span
                className={`min-w-[4ch] tabular-nums ${shown && shown.load > HOT ? 'text-red-600 dark:text-red-400' : ''}`}
              >
                {shown ? `${shown.load}%` : '—'}
              </span>
            </span>
          </Tip>

          <Version />
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * The far right of the bar: the version running, with the mark beside it saying what the release
 * page holds. Number and mark are one button, and what it does is what the mark shows: an amber
 * arrow fetches the version waiting, a green check starts the app again so that version takes
 * over, and a bare number asks the release page again.
 */
function Version() {
  const versions = useVersions();
  const { current, update } = versions;

  useEffect(() => {
    void checkUpdate();
  }, []);

  // What the button is called and what it does both follow the mark it carries.
  const { name, press } =
    update.kind === 'found'
      ? { name: 'Update', press: takeUpdate }
      : update.kind === 'ready'
        ? { name: 'Restart', press: restartApp }
        : { name: 'Version', press: checkUpdate };

  return (
    <Tip text={updateLabel(versions)}>
      <button
        aria-label={name}
        onClick={() => void press()}
        disabled={update.kind === 'taking'}
        className="hover:bg-ink/8 hover:text-ink -mr-2 flex h-full items-center gap-1 rounded-sm pr-2 pl-1.5 transition-colors duration-150"
      >
        {current}
        {(update.kind === 'found' || update.kind === 'taking') && (
          <Download
            {...ICON}
            className={`text-amber-600 dark:text-amber-500 ${update.kind === 'taking' ? 'animate-pulse' : ''}`}
          />
        )}
        {update.kind === 'ready' && (
          <Check {...ICON} className="text-green-600 dark:text-green-500" />
        )}
      </button>
    </Tip>
  );
}

/** One cell's tooltip, over whatever the cell is: a button, or a span that only reads out. */
function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="top">{text}</TooltipContent>
    </Tooltip>
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
 * One cell of the left group: a dot and a line of text, the whole of it a button. The bar is one
 * row high, so a long line is cut off and the tooltip carries it whole.
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
      className="hover:bg-ink/8 flex h-[18px] max-w-[280px] min-w-0 items-center gap-1.5 rounded-sm px-1.5 transition-colors duration-150"
    >
      <Light dot={dot} />
      <span className="truncate">{text}</span>
    </button>
  );
}
