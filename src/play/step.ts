// Where an arrow key takes the cursor: one Onset or one bar along a walk, read in played ticks.
// Pure, so the play screen and the Preview share the one rule.

import type { SeekTarget } from '@/play/engine';
import { barsOfWalk } from '@/score/beat';
import type { PlayStep, Score } from '@/score/types';

/** The part of the screen the pointer stands over, which is what decides which arrows move the play. */
export type Area = 'lane' | 'sheet' | null;

/** Which way each arrow moves; every other key is none of them. */
const BACK: Record<string, boolean> = {
  ArrowUp: false,
  ArrowRight: false,
  ArrowDown: true,
  ArrowLeft: true,
};

/**
 * Whether an arrow moves back, or null where the pointer's area ignores it: the falling notes take
 * the vertical pair, the sheet the horizontal one, everywhere else all four.
 */
export function arrowBack(key: string, area: Area): boolean | null {
  const vertical = key === 'ArrowUp' || key === 'ArrowDown';
  if (area === 'lane' && !vertical) return null;
  if (area === 'sheet' && vertical) return null;
  return BACK[key] ?? null;
}

/**
 * Where one arrow press lands, or null at the first or the last of them. A bar step lands on a bar
 * line, so back from inside a bar opens that bar and back from its line reaches the bar before.
 */
export function stepTarget(
  score: Score,
  walk: PlayStep[],
  playedTick: number,
  back: boolean,
  bar: boolean,
): SeekTarget | null {
  if (bar) {
    const bars = barsOfWalk(score, walk);
    const at = back
      ? bars.findLast((line) => line.tick < playedTick)
      : bars.find((line) => line.tick > playedTick);
    return at ? { measure: at.measure.index } : null;
  }
  const step = back
    ? walk.findLast((at) => at.tick < playedTick)
    : walk.find((at) => at.tick > playedTick);
  return step ? { onset: step.onsetIndex } : null;
}
