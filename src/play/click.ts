// The metronome click. Web Audio only: the app makes no other sound, so one short blip is all of
// it. The engine decides when a click is owed; this file only makes the noise.

import { clamp } from '@/lib/utils';

/** Length of one click, short enough to read as a tick and not as a pitch. */
const CLICK_MS = 30;
const CLICK_HZ = 1600;

let context: AudioContext | undefined;
/** The `click_volume` global setting, 0 to 100. */
let volume = 70;

export function setClickVolume(percent: number): void {
  volume = clamp(percent, 0, 100);
}

/** One click now. Silent at volume 0, and in any environment without Web Audio. */
export function click(): void {
  if (volume === 0 || typeof AudioContext === 'undefined') return;
  context ??= new AudioContext();
  // A context built outside a user gesture starts suspended; the play it clicks for began in one.
  if (context.state === 'suspended') void context.resume();
  const at = context.currentTime;
  const gain = context.createGain();
  // An exponential fall to silence, because a square end of the tone would pop.
  gain.gain.setValueAtTime((volume / 100) * 0.3, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + CLICK_MS / 1000);
  const tone = context.createOscillator();
  tone.frequency.value = CLICK_HZ;
  tone.connect(gain).connect(context.destination);
  tone.start(at);
  tone.stop(at + CLICK_MS / 1000);
}
