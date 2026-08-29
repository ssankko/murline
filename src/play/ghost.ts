// The inactive hand playing itself. The play engine says which of its notes are owed a note-on and
// which a note-off as the clock passes them; this file sends each through the sound engine, the
// same path a MIDI key takes, and keeps what is still down so a screen going away can let it go.

import type { GhostEvent } from '@/play/engine';
import { invoke } from '@tauri-apps/api/core';

/** The pitches sounding now, so nothing is left ringing. */
const held = new Set<number>();

/** One note the engine owes. Silent on a build without a sound engine. */
export function ghost({ midi, velocity, on }: GhostEvent): void {
  if (on) held.add(midi);
  else held.delete(midi);
  invoke('audio_note', { midi, velocity, on }).catch(console.error);
}

/** Lets go of every note still sounding, at once. */
export function silenceGhosts(): void {
  for (const midi of held) {
    invoke('audio_note', { midi, velocity: 0, on: false }).catch(console.error);
  }
  held.clear();
}
