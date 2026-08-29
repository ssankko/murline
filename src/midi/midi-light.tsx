// The MIDI light: the popover where the player says which devices count, hanging from the status
// bar's MIDI cell, with a piano glyph of its own for any caller that gives it no trigger.

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  hideDevice,
  setDefaultDevice,
  showDevice,
  useDevice,
  useMidiStatus,
} from '@/midi/use-midi-status';
import { BarButton, ICON } from '@/screens/bar';
import { Piano } from 'lucide-react';
import { useState } from 'react';

/**
 * Lists every source the machine has. The machine offers other Macs, phones and buses as MIDI
 * sources, so the choice of which are keyboards is the player's: Use is for this session, Default
 * is for every launch, and Hide keeps one out of the way until it is shown again.
 */
export function MidiLight({
  open,
  onOpenChange,
  trigger,
}: {
  /** Held by the screen, because a search result in the settings panel opens this too. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What opens the popover, when it is not the bar button: the status bar's own MIDI cell. */
  trigger?: React.ReactNode;
}) {
  const { devices, ports, pinned, defaultId, hidden, error } = useMidiStatus();
  const [showAway, setShowAway] = useState(false);
  const label = error ?? (devices.length ? devices.join(', ') : 'No MIDI device');
  const away = ports.filter((port) => hidden.includes(port.id));

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        {trigger ?? (
          <BarButton label={label} dim={error !== null || devices.length === 0}>
            <Piano {...ICON} />
          </BarButton>
        )}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="flex w-72 flex-col gap-2 p-3">
        <p className="text-muted-ink text-[11px] leading-snug">
          {error ?? (devices.length ? `Listening to ${devices.join(', ')}` : 'No MIDI device')}
        </p>
        <div className="border-edge-soft flex flex-col gap-1 border-t pt-2">
          <Row
            name="Any device"
            inUse={pinned === null}
            byDefault={defaultId === null}
            onUse={() => useDevice(null)}
            onDefault={() => setDefaultDevice(null)}
          />
          {ports
            .filter((port) => !hidden.includes(port.id))
            .map((port) => (
              <Row
                key={port.id}
                name={port.name}
                inUse={pinned === port.id}
                byDefault={defaultId === port.id}
                onUse={() => useDevice(port.id)}
                onDefault={() => setDefaultDevice(port.id)}
                onHide={() => hideDevice(port.id)}
              />
            ))}
        </div>
        {away.length > 0 && (
          <div className="border-edge-soft flex flex-col gap-1 border-t pt-2">
            <button
              aria-expanded={showAway}
              onClick={() => setShowAway((shown) => !shown)}
              className="hover:text-ink text-muted-ink self-start text-[12px]"
            >
              Hidden ({away.length})
            </button>
            {showAway &&
              away.map((port) => (
                <div key={port.id} className="flex items-center gap-1.5">
                  <span className="text-muted-ink min-w-0 flex-1 truncate text-[12px]">
                    {port.name}
                  </span>
                  <Small label={`Show ${port.name}`} onClick={() => showDevice(port.id)}>
                    Show
                  </Small>
                </div>
              ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** One source: what it is called, and the three things the player can do about it. */
function Row({
  name,
  inUse,
  byDefault,
  onUse,
  onDefault,
  onHide,
}: {
  name: string;
  inUse: boolean;
  byDefault: boolean;
  onUse: () => void;
  onDefault: () => void;
  /** Absent on "Any device", which is the rule rather than a device to put away. */
  onHide?: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="min-w-0 flex-1 truncate text-[12px]" title={name}>
        {name}
      </span>
      <Small label={`Use ${name}`} pressed={inUse} onClick={onUse}>
        {inUse ? 'In use' : 'Use'}
      </Small>
      <Small label={`Default ${name}`} pressed={byDefault} onClick={onDefault}>
        Default
      </Small>
      {onHide && (
        <Small label={`Hide ${name}`} onClick={onHide}>
          Hide
        </Small>
      )}
    </div>
  );
}

/** A row's button: outlined, and filled while it is the one in force. */
function Small({
  label,
  pressed,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="outline"
      size="xs"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="aria-pressed:bg-ink aria-pressed:text-paper aria-pressed:border-ink flex-none font-normal"
    >
      {children}
    </Button>
  );
}
