// Two popovers the status bar hangs: the mixer behind the volume cells, with the two faders, and
// the sound popover behind the sound cell, with the Sound tab's own controls. Both name the sound's
// way out and both hold the link into the rest of the Sound tab.

import { SoundControls, useAudioStatus, type AudioStatus } from '@/audio/sound-tab';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { readSettings, setSetting } from '@/db/db';
import { sticky } from '@/lib/utils';
import type { SettingChange } from '@/screens/settings';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

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
  onGlobalChange,
  trigger,
}: {
  /** Held by the screen, because a search result in the settings panel opens the mixer too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The way into the rest of the Sound tab: the output device, the envelope, the velocity. */
  onSoundSettings: () => void;
  onGlobalChange?: (...change: SettingChange) => void;
  /** What opens the popover: the status bar's pair of volume cells. */
  trigger: React.ReactNode;
}) {
  const [values, setValues] = useState<{ keyboard: number; click: number } | null>(null);
  const status = useAudioStatus();

  // Read at every open, the way the settings panel does, so the faders are in step with whatever
  // wrote them last.
  useEffect(() => {
    if (!open) return;
    readSettings().then(
      (settings) => setValues({ keyboard: settings.keyboard_volume, click: settings.click_volume }),
      console.error,
    );
  }, [open]);

  function writeKeyboard(percent: number): void {
    setValues((held) => held && { ...held, keyboard: percent });
    setSetting('keyboard_volume', percent).catch(console.error);
    // In place in the running graph: nothing is reconnected, so a note ringing while the fader
    // moves keeps ringing.
    invoke('audio_set_keyboard_volume', { percent }).catch(console.error);
    onGlobalChange?.('keyboard_volume', percent);
  }

  function writeClick(percent: number): void {
    setValues((held) => held && { ...held, click: percent });
    setSetting('click_volume', percent).catch(console.error);
    // The play screen's metronome reads it from here, so a change lands mid-practice.
    onGlobalChange?.('click_volume', percent);
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent side="top" align="end" className={`${PANEL} w-96`}>
        <Fader
          label="Keyboard"
          max={200}
          value={values?.keyboard ?? 100}
          disabled={!values}
          onChange={writeKeyboard}
        />
        <Fader
          label="Metronome"
          value={values?.click ?? 0}
          disabled={!values}
          onChange={writeClick}
        />
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

function Fader({
  label,
  max = 100,
  value,
  disabled,
  onChange,
}: {
  label: string;
  /** The top of the range. The keyboard fader goes past unity, the metronome's does not. */
  max?: number;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-[12px]">
      <span className="w-20 flex-none">{label}</span>
      <input
        type="range"
        aria-label={label}
        min={0}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(sticky(Number(event.target.value)))}
        className="accent-ink min-w-0 flex-1 disabled:opacity-30"
      />
      <span className="text-muted-ink w-8 flex-none text-right text-[11px] tabular-nums">
        {value}
      </span>
    </label>
  );
}
