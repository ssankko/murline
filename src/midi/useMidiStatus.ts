import { getSetting } from '@/db/db';
import type { StrikeEvent } from '@/play/engine';
import { useEffect, useRef, useSyncExternalStore } from 'react';

/** One MIDI input port as the settings dialog lists it. */
export type MidiPort = { id: string; name: string };

export type MidiStatus = {
  /** Display names of every input port being listened to, in the order the plugin lists them. */
  devices: string[];
  /** Every input port the machine has, whether or not one of them is pinned. */
  ports: MidiPort[];
  /** Set when MIDI is unreachable, which outside the Tauri window is always. */
  error: string | null;
};

/**
 * Connected MIDI inputs, kept current from the plugin's `statechange` event, and every key they
 * send. The plugin injects a Web MIDI polyfill into the webview, so this is the standard API and
 * nothing imports the plugin. Its timestamps are Unix milliseconds stamped in Rust, the timeline
 * `performance.timeOrigin + performance.now()` also runs on.
 *
 * The ports are opened once for the whole app, so a screen and a dialog can both read the strikes:
 * setting `onmidimessage` is what opens a port, and a second listener would take it off the first.
 * The `midi_device` setting pins one port by id; unset, every input port is listened to.
 */
export function useMidiStatus(onStrike?: (event: StrikeEvent) => void): MidiStatus {
  const handler = useRef(onStrike);
  handler.current = onStrike;

  useEffect(() => {
    const strike = (event: StrikeEvent) => handler.current?.(event);
    strikes.add(strike);
    return () => {
      strikes.delete(strike);
    };
  }, []);

  return useSyncExternalStore(subscribe, () => status);
}

/**
 * Pins one input port by id, or listens on every one again with null. The `midi_device` setting is
 * written by the caller; this is what the ports do about it at once.
 */
export function pinMidiDevice(id: string | null): void {
  pinned = id;
  if (access) read(access);
}

let access: MIDIAccess | null = null;
let started = false;
let pinned: string | null = null;
let status: MidiStatus = { devices: [], ports: [], error: null };
const strikes = new Set<(event: StrikeEvent) => void>();
const listeners = new Set<() => void>();

function subscribe(listen: () => void): () => void {
  listeners.add(listen);
  start();
  return () => {
    listeners.delete(listen);
  };
}

function publish(next: Partial<MidiStatus>): void {
  status = { ...status, ...next };
  for (const listen of listeners) listen();
}

function message(event: MIDIMessageEvent): void {
  const data = event.data;
  if (!data || data.length < 3) return;
  const state = data[0]! & 0xf0;
  if (state !== 0x90 && state !== 0x80) return;
  const velocity = data[2]!;
  const strike: StrikeEvent = {
    midi: data[1]!,
    velocity,
    time: event.timeStamp,
    on: state === 0x90 && velocity > 0,
  };
  for (const listen of strikes) listen(strike);
}

/** Opens the pinned ports and lists them all. Setting `onmidimessage` is what opens a port. */
function read(a: MIDIAccess): void {
  const inputs = [...a.inputs.values()];
  const listening = inputs.filter((input) => !pinned || input.id === pinned);
  for (const input of inputs) input.onmidimessage = listening.includes(input) ? message : null;
  publish({
    devices: listening.map((input) => input.name || input.id),
    ports: inputs.map((input) => ({ id: input.id, name: input.name || input.id })),
  });
}

function start(): void {
  if (started) return;
  started = true;
  void getSetting('midi_device')
    .catch(() => null)
    .then((device) => {
      pinned = device;
      const asked = navigator.requestMIDIAccess?.();
      if (!asked) return publish({ error: 'Web MIDI is not available' });
      return asked.then(
        (a) => {
          access = a;
          a.onstatechange = (event) => {
            // A port that went away keeps its Rust connection open, which stops the same port from
            // delivering anything after a re-plug. Closing it here is what frees it.
            if (event.port?.state === 'disconnected') event.port.close();
            read(a);
          };
          read(a);
        },
        (error: unknown) => publish({ error: String(error) }),
      );
    });
}
