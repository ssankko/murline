import { set, setting } from '@/settings/settings';
import type { StrikeEvent } from '@/play/engine';
import { call, on, type MidiPorts } from '@/rust';
import { useEffect, useRef, useSyncExternalStore } from 'react';

/** What the MIDI popover shows: the Rust side's ports, and the two rules the window keeps. */
export type MidiStatus = MidiPorts & {
  /** The port the next launch starts on, out of `midi_device`. */
  defaultId: string | null;
  /** Ids of the ports "Any device" passes over. */
  hidden: string[];
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

/** Listens on one port for the rest of the session, or on every port outside `hidden` with null. */
export function useDevice(id: string | null): void {
  session = id;
  void send();
}

/** Writes the port every launch starts on, and hands the session back to it. */
export function setDefaultDevice(id: string | null): void {
  session = undefined;
  publish({ defaultId: id });
  void set('midi_device', id);
  void send();
}

/** Puts a port away. A hidden port is neither the pin nor the default, or it would open anyway. */
export function hideDevice(id: string): void {
  if (session === id) session = undefined;
  if (status.defaultId === id) {
    publish({ defaultId: null });
    void set('midi_device', null);
  }
  void hide([...status.hidden, id]);
}

/** Brings a port back into the list "Any device" opens. */
export function showDevice(id: string): void {
  void hide(status.hidden.filter((each) => each !== id));
}

let started = false;
let status: MidiStatus = {
  devices: [],
  ports: [],
  pinned: null,
  defaultId: null,
  hidden: [],
  error: null,
};
/**
 * The port picked for this session, `undefined` while the default rules. Null cannot say that:
 * null is "Any device" picked for the session, which outranks a default naming a port.
 */
let session: string | null | undefined;
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

/** The listening rule as it stands, sent whole at every change. Rust reads the stored rule for
 * itself at boot; what it hears from here is the session pin over it. */
function send(): Promise<void> {
  const pinned = session === undefined ? status.defaultId : session;
  return call('midi_listen', { pinned, hidden: status.hidden }).catch((error: unknown) =>
    publish({ error: String(error) }),
  );
}

function hide(hidden: string[]): Promise<void> {
  publish({ hidden });
  void set('midi_hidden', hidden);
  return send();
}

function start(): void {
  if (started) return;
  started = true;
  void (async () => {
    on('midi-strike', (strike) => {
      for (const handler of strikes) handler(strike);
    });
    on('midi-ports', publish);
    publish({ defaultId: setting('midi_device'), hidden: setting('midi_hidden') });
    // The rule goes out before the first look at the ports, so what comes back is the rule's.
    await send();
    publish(await call('midi_status'));
  })().catch((error: unknown) => publish({ error: String(error) }));
}
