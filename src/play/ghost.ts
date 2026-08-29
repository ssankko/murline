// The inactive hand playing itself. The play engine says which of its notes are owed a note-on and
// which a note-off as the clock passes them; this file decides how loud each one sounds, sends it
// through the sound engine and keeps what is still down so a screen going away can let it go.

import type { GhostEvent } from '@/play/engine';
import type { PlaySettings } from '@/play/settings';
import { clamp } from '@/lib/utils';
import { invoke } from '@tauri-apps/api/core';

/** The pitches sounding now, so nothing is left ringing. */
const held = new Set<number>();

/** Weight of the newest strike in `recent`: about eight strikes for the loudness to settle. */
const FOLLOW_WEIGHT = 1 / 8;

/** How hard the player has been striking lately, an output velocity; null before the first strike. */
let recent: number | null = null;

/** One strike of the player's own hands, folded into the loudness "Follows you" plays at. */
export function ghostStrike(velocity: number): void {
  recent = recent === null ? velocity : recent + (velocity - recent) * FOLLOW_WEIGHT;
}

/**
 * One note the engine owes, at the level the settings ask for, over the written dynamics or over
 * the player's recent loudness. `recent` is already an output velocity, so `raw` keeps the velocity
 * curve off it; every other source is an input velocity and takes the curve. Silent on a build
 * without a sound engine.
 */
export function ghost({ midi, velocity, on }: GhostEvent, settings: PlaySettings): void {
  const player = settings.inactiveHandVelocity === 'follow' ? recent : null;
  const level = clamp(Math.round(((player ?? velocity) * settings.inactiveHandLevel) / 100), 1, 127);
  if (on) held.add(midi);
  else held.delete(midi);
  const sent = { midi, velocity: on ? level : 0, on, raw: on && player !== null };
  invoke('audio_note', sent).catch(console.error);
}

/** Lets go of every note still sounding, at once, and forgets how hard the player was striking. */
export function silenceGhosts(): void {
  for (const midi of held) {
    invoke('audio_note', { midi, velocity: 0, on: false, raw: false }).catch(console.error);
  }
  held.clear();
  recent = null;
}
