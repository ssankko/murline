// Two popovers the status bar hangs: the mixer behind the volume cells, with the two faders, and
// the sound popover behind the sound cell, with the Sound tab's own controls. Both name the sound's
// way out and both hold the link into the rest of the Sound tab.

import { Knob } from '@/audio/knob';
import { SoundControls, useAudioStatus } from '@/audio/sound-tab';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { sticky } from '@/lib/utils';
import { type AudioStatus } from '@/rust';
import { set, useSetting } from '@/settings/settings';
import { useState } from 'react';

/** What the line under a popover says: the sound's way out, or why there is none. */
function output(status: AudioStatus | null): string {
  if (!status) return '';
  if (!status.available) return status.reason;
  return [status.device_name, status.instrument].filter(Boolean).join(' · ');
}

/** One scroll rule for both popovers; each sets its own width. */
const PANEL = 'flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-3';

/**
 * The mixer popover. The keyboard fader is a gain in the sound engine after the effect chain,
 * running from silence to twice the sound the instrument makes, and it leaves the instrument and
 * the effects answering the hands exactly as they did. The metronome fader is the click's own
 * volume and shares nothing with it.
 */
export function Mixer({
  open,
  onOpenChange,
  onSoundSettings,
  trigger,
}: {
  /** Held by the screen, because a search result in the settings panel opens the mixer too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The way into the rest of the Sound tab: the output device, the envelope, the velocity. */
  onSoundSettings: () => void;
  /** What opens the popover: the status bar's pair of volume cells. */
  trigger: React.ReactNode;
}) {
  const keyboard = useSetting('keyboard_volume');
  const click = useSetting('click_volume');
  const status = useAudioStatus();
  /** Why the engine would not take the keyboard fader, shown until a move it takes. */
  const [failure, setFailure] = useState('');

  /** The gain goes in place in the running graph, so a note ringing as the fader moves keeps
   * ringing. */
  function writeKeyboard(percent: number): void {
    void set('keyboard_volume', percent).then(setFailure);
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="top" align="end" className={`${PANEL} w-96`}>
        <Knob
          id="keyboard_volume"
          label="Keyboard"
          hint="100% is the instrument's own; a limiter stops clipping."
          lo={0}
          hi={200}
          value={keyboard}
          readout={`${keyboard}%`}
          onChange={(percent) => writeKeyboard(sticky(percent))}
        />
        <Knob
          id="click_volume"
          label="Metronome"
          hint="The click's own volume, straight to the output."
          lo={0}
          hi={100}
          value={click}
          readout={`${click}%`}
          onChange={(percent) => void set('click_volume', sticky(percent))}
        />
        {failure && <p className="text-muted-ink text-[11px] leading-snug">{failure}</p>}
        <Foot status={status} onOpenChange={onOpenChange} onSoundSettings={onSoundSettings} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The sound popover: everything the Sound tab holds about the sound itself, without the instruments
 * folder row. It is wider than the mixer because the touch and envelope plots stand beside their
 * sliders. Where the sound goes out is one link away.
 */
export function SoundPopover({
  open,
  onOpenChange,
  onSoundSettings,
  onChanged,
  trigger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The way into the rest of the Sound tab: the output device and the instruments folder. */
  onSoundSettings: () => void;
  /** A new instrument, so the status bar's sound cell can be read again at once. */
  onChanged?: () => void;
  /** What opens the popover: the status bar's sound cell. */
  trigger: React.ReactNode;
}) {
  const status = useAudioStatus();

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="top" align="start" className={`${PANEL} w-[460px]`}>
        <div className="flex min-w-0 flex-col gap-7">
          <SoundControls folder={false} onChanged={onChanged} />
        </div>
        <Foot status={status} onOpenChange={onOpenChange} onSoundSettings={onSoundSettings} />
      </PopoverContent>
    </Popover>
  );
}

/** The foot both popovers share: what the sound comes out of, and the way into the Sound tab. */
function Foot({
  status,
  onOpenChange,
  onSoundSettings,
}: {
  status: AudioStatus | null;
  onOpenChange: (open: boolean) => void;
  onSoundSettings: () => void;
}) {
  return (
    <div className="border-edge-soft flex flex-col items-start gap-1.5 border-t pt-3">
      {output(status) && (
        <p className="text-muted-ink text-[11px] leading-snug">{output(status)}</p>
      )}
      <button
        onClick={() => {
          onOpenChange(false);
          onSoundSettings();
        }}
        className="hover:text-ink text-muted-ink text-[12px] underline underline-offset-2"
      >
        Sound settings…
      </button>
    </div>
  );
}
