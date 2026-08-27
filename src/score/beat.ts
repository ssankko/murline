// How a bar of the Score is counted: the beat the metronome, the harmony grid and the lane share,
// and the bar line a step of a walk stands after.

import { TICKS_PER_QUARTER, type Measure, type Onset, type PlayStep, type Score } from '@/score/types';

/**
 * The beat a bar is counted in and how many of them it holds: the time signature's unit, a dotted
 * quarter in the compound meters 6/8, 9/8 and 12/8.
 */
export function beatOf(measure: Measure): { ticks: number; perBar: number } {
  const unit = (TICKS_PER_QUARTER * 4) / measure.beatUnit;
  const compound =
    measure.beatUnit === 8 && measure.beatsPerBar > 3 && measure.beatsPerBar % 3 === 0;
  return compound
    ? { ticks: unit * 3, perBar: measure.beatsPerBar / 3 }
    : { ticks: unit, perBar: measure.beatsPerBar };
}

/** Played tick of the bar line that opens the bar a walk step stands in. */
export function barTickOf(step: PlayStep, onset: Onset, measure: Measure): number {
  return step.tick - (onset.tick - measure.startTick);
}

/** Every bar the walk passes through, in played ticks: a repeated bar comes once per pass. */
export function barsOfWalk(score: Score, walk: PlayStep[]): { measure: Measure; tick: number }[] {
  const bars: { measure: Measure; tick: number }[] = [];
  for (const step of walk) {
    const onset = score.onsets[step.onsetIndex];
    const measure = onset ? score.measures[onset.measureIndex] : undefined;
    if (!onset || !measure) continue;
    const tick = barTickOf(step, onset, measure);
    if (bars.at(-1)?.tick === tick) continue;
    bars.push({ measure, tick });
  }
  return bars;
}
