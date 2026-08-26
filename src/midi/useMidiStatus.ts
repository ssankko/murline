import { getSetting } from '@/db/db';
import type { StrikeEvent } from '@/play/engine';
import { useEffect, useRef, useState } from 'react';

export type MidiStatus = {
  /** Display names of every input port being listened to, in the order the plugin lists them. */
  devices: string[];
  /** Set when MIDI is unreachable, which outside the Tauri window is always. */
  error: string | null;
};

/**
 * Connected MIDI inputs, kept current from the plugin's `statechange` event, and every key they
 * send when a handler is given. The plugin injects a Web MIDI polyfill into the webview, so this is
 * the standard API and nothing imports the plugin. Its timestamps are Unix milliseconds stamped in
 * Rust, the timeline `performance.timeOrigin + performance.now()` also runs on.
 *
 * The `midi_device` setting pins one port by id; unset, every input port is listened to.
 */
export function useMidiStatus(onStrike?: (event: StrikeEvent) => void): MidiStatus {
  const [devices, setDevices] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const handler = useRef(onStrike);
  handler.current = onStrike;

  useEffect(() => {
    let access: MIDIAccess | undefined;
    let dropped = false;

    const message = (event: MIDIMessageEvent) => {
      const data = event.data;
      if (!data || data.length < 3) return;
      const status = data[0]! & 0xf0;
      if (status !== 0x90 && status !== 0x80) return;
      const velocity = data[2]!;
      handler.current?.({
        midi: data[1]!,
        velocity,
        time: event.timeStamp,
        on: status === 0x90 && velocity > 0,
      });
    };

    // Setting `onmidimessage` is what opens a port, so this both lists and listens.
    const read = (a: MIDIAccess, device: string | null) => {
      const inputs = [...a.inputs.values()].filter((input) => !device || input.id === device);
      for (const input of inputs) input.onmidimessage = message;
      setDevices(inputs.map((input) => input.name || input.id));
    };

    void getSetting('midi_device')
      .catch(() => null)
      .then((device) => {
        if (dropped) return;
        return navigator.requestMIDIAccess?.().then(
          (a) => {
            if (dropped) return;
            access = a;
            a.onstatechange = (event) => {
              // A port that went away keeps its Rust connection open, which stops the same port
              // from delivering anything after a re-plug. Closing it here is what frees it.
              if (event.port?.state === 'disconnected') event.port.close();
              read(a, device);
            };
            read(a, device);
          },
          (e: unknown) => !dropped && setError(String(e)),
        ) ?? setError('Web MIDI is not available');
      });

    return () => {
      dropped = true;
      if (!access) return;
      access.onstatechange = null;
      for (const input of access.inputs.values()) input.onmidimessage = null;
    };
  }, []);

  return { devices, error };
}
