import { getSetting } from '@/db/db';
import type { StrikeEvent } from '@/play/engine';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef, useSyncExternalStore } from 'react';

/** One MIDI input port as the settings dialog lists it. */
export type MidiPort = { id: string; name: string };

export type MidiStatus = {
  /** Display names of every input port being listened to, in the order Rust lists them. */
  devices: string[];
  /** Every input port the machine has, whether or not one of them is pinned. */
  ports: MidiPort[];
  /** Set when MIDI is unreachable, which outside the Tauri window is always. */
  error: string | null;
};

/**
 * Connected MIDI inputs and every key they send. Rust owns the ports: it sounds the note through
 * the engine first and then emits the strike here, so the timestamps are the same Unix
 * milliseconds on the `performance.timeOrigin + performance.now()` timeline as before. The events
 * are subscribed to once for the whole app.
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
 * written by the caller; Rust reopens the ports and says which it listens to in `midi-ports`.
 */
export function pinMidiDevice(id: string | null): void {
  invoke('midi_pin', { id }).catch((error: unknown) => publish({ error: String(error) }));
}

let started = false;
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

function start(): void {
  if (started) return;
  started = true;
  void (async () => {
    await listen<StrikeEvent>('midi-strike', ({ payload }) => {
      for (const strike of strikes) strike(payload);
    });
    await listen<MidiStatus>('midi-ports', ({ payload }) => publish(payload));
    // Rust has no settings of its own, so the pin is sent before the first look at the ports.
    const device = await getSetting('midi_device').catch(() => null);
    await invoke('midi_pin', { id: device });
    publish(await invoke<MidiStatus>('midi_status'));
  })().catch((error: unknown) => publish({ error: String(error) }));
}
