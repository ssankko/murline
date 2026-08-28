// The mixer: the volume button that sits beside the settings button on every screen, and the
// popover behind it. Two faders and one line saying what the sound is coming out of.

import { useAudioStatus, type AudioStatus } from '@/audio/sound-tab';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { readSettings, setSetting } from '@/db/db';
import type { SettingChange } from '@/screens/settings';
import { invoke } from '@tauri-apps/api/core';
import { Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';

/** What the line under the faders says: the sound's way out, or why there is none. */
function output(status: AudioStatus | null): string {
  if (!status) return '';
  if (!status.available) return status.reason;
  return [status.device_name, status.instrument].filter(Boolean).join(' · ');
}

/**
 * The volume button and its mixer. The keyboard fader is a gain in the sound engine after the
 * effect chain, running from silence to twice the sound the instrument makes, and it leaves the
 * instrument and the effects answering the hands exactly as they did. The metronome fader is the
 * click's own volume and shares nothing with it.
 *
 * The button carries a badge whenever the engine cannot make sound, so a silent app says so from
 * the header bar without being opened.
 */
export function Mixer({
  open,
  onOpenChange,
  onSoundSettings,
  onGlobalChange,
}: {
  /** Held by the screen, because a search result in the settings panel opens the mixer too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The way into the Sound tab, which is where the device and the instrument are chosen. */
  onSoundSettings: () => void;
  onGlobalChange?: (...change: SettingChange) => void;
}) {
  const [values, setValues] = useState<{ keyboard: number; click: number } | null>(null);
  const status = useAudioStatus();
  const down = status !== null && !status.available;

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
      <PopoverTrigger asChild>
        <button
          aria-label="Volume"
          data-engine={down ? 'down' : undefined}
          title={down ? status.reason : undefined}
          className="hover:bg-ink/8 relative flex size-8 flex-none items-center justify-center rounded-md transition-colors duration-150"
        >
          <Volume2 size={18} strokeWidth={1.75} />
          {down && (
            <span
              aria-hidden
              className="bg-ink ring-chrome absolute top-1 right-1 size-1.5 rounded-full ring-2"
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="flex w-64 flex-col gap-3 p-3">
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
