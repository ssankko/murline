import { useEffect, useState } from 'react';

export type MidiStatus = {
  /** Display names of every connected input port, in the order the plugin lists them. */
  devices: string[];
  /** Set when MIDI is unreachable, which outside the Tauri window is always. */
  error: string | null;
};

/**
 * Connected MIDI inputs, kept current from the plugin's `statechange` event. The plugin injects a
 * Web MIDI polyfill into the webview, so this is the standard API and nothing imports the plugin.
 */
export function useMidiStatus(): MidiStatus {
  const [devices, setDevices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let access: MIDIAccess | undefined;
    let dropped = false;

    const read = (a: MIDIAccess) =>
      setDevices([...a.inputs.values()].map((input) => input.name || input.id));

    navigator.requestMIDIAccess?.().then(
      (a) => {
        if (dropped) return;
        access = a;
        a.onstatechange = () => read(a);
        read(a);
      },
      (e: unknown) => !dropped && setError(String(e)),
    ) ?? setError('Web MIDI is not available');

    return () => {
      dropped = true;
      if (access) access.onstatechange = null;
    };
  }, []);

  return { devices, error };
}
