// The mixer: the popover behind the status bar's volume cells. Two faders, the line saying what
// the sound comes out of, and the Sound tab's own instrument picker and effect chain.

import { EffectsSection } from '@/audio/effects';
import { InstrumentSection } from '@/audio/instrument';
import { useAudioStatus, type AudioStatus } from '@/audio/sound-tab';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { readSettings, setSetting } from '@/db/db';
import type { SettingChange } from '@/screens/settings';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

/** What the line under the sections says: the sound's way out, or why there is none. */
function output(status: AudioStatus | null): string {
  if (!status) return '';
  if (!status.available) return status.reason;
  return [status.device_name, status.instrument].filter(Boolean).join(' · ');
}

/**
 * The mixer popover. The keyboard fader is a gain in the sound engine after the effect chain,
 * running from silence to twice the sound the instrument makes, and it leaves the instrument and
 * the effects answering the hands exactly as they did. The metronome fader is the click's own
 * volume and shares nothing with it. Under the faders stand the instrument and the chain that make
 * the sound, the same two sections the Sound tab holds; the rest of the tab is one link away.
 */
export function Mixer({
  open,
  onOpenChange,
  onSoundSettings,
  onGlobalChange,
  onChanged,
  trigger,
}: {
  /** Held by the screen, because a search result in the settings panel opens the mixer too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The way into the rest of the Sound tab: the output device, the envelope, the velocity. */
  onSoundSettings: () => void;
  onGlobalChange?: (...change: SettingChange) => void;
  /** A new instrument, so the status bar's sound cell can be read again at once. */
  onChanged?: () => void;
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
      <PopoverContent
        side="top"
        align="end"
        className="flex max-h-[70vh] w-96 flex-col gap-3 overflow-y-auto p-3"
      >
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
        <div className="border-edge-soft flex flex-col gap-4 border-t pt-3">
          <InstrumentSection onChanged={onChanged} />
          <EffectsSection />
        </div>
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
      </PopoverContent>
    </Popover>
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
        onChange={(event) => onChange(Number(event.target.value))}
        className="accent-ink min-w-0 flex-1 disabled:opacity-30"
      />
      <span className="text-muted-ink w-8 flex-none text-right text-[11px] tabular-nums">
        {value}
      </span>
    </label>
  );
}
