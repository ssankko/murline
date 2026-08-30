// The metronome click. The noise itself is made by the sound engine on the Rust side, so the click
// comes out of the same output device as the piano; this file only says when one is owed and how
// loud. The play engine decides which beats those are.

import { clamp } from '@/lib/utils';
import { call } from '@/rust';

/** The two clicks: strong on the beat a bar opens with, weak on every other. */
export type ClickStrength = 'strong' | 'weak';

/** The `click_volume` global setting, 0 to 100. */
let volume = 70;

export function setClickVolume(percent: number): void {
  volume = clamp(percent, 0, 100);
}

/** One click now. Silent at volume 0, and on a build without a sound engine. */
export function click(strength: ClickStrength): void {
  if (volume === 0) return;
  call('audio_click', { strength, volume }).catch(console.error);
}
