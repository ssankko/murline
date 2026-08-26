// The Section: a range of whole bars picked by dragging on the sheet, and the walk Loop plays it
// on. A Section on its own is inert; Loop is what gives it force, in src/play/engine.ts.

import type { PlayStep, Score } from '@/score/types';

/** A range of whole bars as measure indices, both ends inside it. */
export interface Section {
  from: number;
  to: number;
}

/** Both ends inside the piece, and the start never after the end. */
export function clampSection(score: Score, section: Section): Section {
  const last = Math.max(score.measures.length - 1, 0);
  const inside = (index: number) => Math.min(Math.max(index, 0), last);
  return {
    from: inside(Math.min(section.from, section.to)),
    to: inside(Math.max(section.from, section.to)),
  };
}

/**
 * Every Onset once, in written order. Loop runs the play on this walk, so bars play linearly with
 * no repeat and no jump, and a played tick is the same number as a sheet tick.
 */
export function linearWalk(score: Score): PlayStep[] {
  return score.onsets.map((onset, index) => ({ onsetIndex: index, tick: onset.tick }));
}

/** The bar lines that open and close a Section, in sheet ticks. */
export function sectionTicks(score: Score, section: Section): { from: number; to: number } {
  const first = score.measures[section.from];
  const last = score.measures[section.to];
  return {
    from: first?.startTick ?? 0,
    to: (last?.startTick ?? 0) + (last?.durationTicks ?? 0),
  };
}

/** How the loop control names the Section: printed bar numbers, a pickup bar being 0. */
export function sectionLabel(score: Score, section: Section | null): string {
  if (!section) return 'Loop';
  const from = score.measures[section.from]?.number ?? section.from;
  const to = score.measures[section.to]?.number ?? section.to;
  return from === to ? `Loop bar ${from}` : `Loop bars ${from}-${to}`;
}
