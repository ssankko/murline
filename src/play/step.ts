// Where an arrow key or a seek target takes the cursor: one Onset or one bar along a walk, read in
// played ticks. Pure, so the Engine and the Preview share the one rule.

import type { SeekTarget } from '@/play/engine';
import { barsOfWalk, barTickOf } from '@/score/beat';
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

/** Every played tick a seek target stands at: once per pass through it. */
export function playedTicksOf(score: Score, walk: PlayStep[], target: SeekTarget): number[] {
  // A played tick lands on the step nearest it, wherever in the play order that step falls.
  if ('tick' in target) return walk.map((step) => step.tick);
  const ticks: number[] = [];
  for (let i = 0; i < walk.length; i++) {
    const step = walk[i]!;
    const onset = score.onsets[step.onsetIndex];
    if (!onset) continue;
    if ('onset' in target) {
      if (step.onsetIndex === target.onset) ticks.push(step.tick);
      continue;
    }
    if (onset.measureIndex !== target.measure) continue;
    // One candidate per pass: the bar line before the bar's first Onset in this run.
    const before = walk[i - 1];
    const previous = before ? score.onsets[before.onsetIndex] : undefined;
    if (previous?.measureIndex === target.measure) continue;
    const measure = score.measures[target.measure]!;
    ticks.push(barTickOf(step, onset, measure) + (target.into ?? 0));
  }
  return ticks;
}

/** The tick of the list nearest a played tick, the first of them on a tie; `to` itself for none. */
export function nearestTick(ticks: number[], to: number): number {
  if (ticks.length === 0) return to;
  return ticks.reduce((best, tick) => (Math.abs(tick - to) < Math.abs(best - to) ? tick : best));
}
