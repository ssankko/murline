// The MIDI light on every bar: a piano glyph that is full ink while a keyboard is connected.

import { useMidiStatus } from '@/midi/use-midi-status';
import { BarButton, ICON } from '@/screens/bar';
import { Piano } from 'lucide-react';

/**
 * Says from the bar whether a MIDI keyboard is connected: full ink with the device names as its
 * tooltip while one is, dimmed with "No MIDI device" or the error text while none is. A click is
 * the way to the input device row of the settings panel.
 */
export function MidiLight({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { devices, error } = useMidiStatus();
  const label = error ?? (devices.length ? devices.join(', ') : 'No MIDI device');
  return (
    <BarButton label={label} dim={error !== null || devices.length === 0} onClick={onOpenSettings}>
      <Piano {...ICON} />
    </BarButton>
  );
}
