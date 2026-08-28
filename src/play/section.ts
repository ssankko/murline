// The Section: a range of whole bars picked by dragging on the sheet. A Section on its own is
// inert; Loop is what gives it force, in src/play/engine.ts.

import { clamp } from '@/lib/utils';
import type { Measure } from '@/score/types';

/** A range of whole bars as measure indices, both ends inside it. */
export interface Section {
  from: number;
  to: number;
}

/** Both ends inside the piece, and the start never after the end. */
export function clampSection(measures: Measure[], section: Section): Section {
  const last = Math.max(measures.length - 1, 0);
  const inside = (index: number) => clamp(index, 0, last);
  return {
    from: inside(Math.min(section.from, section.to)),
    to: inside(Math.max(section.from, section.to)),
  };
}

/**
 * The Section a piece reopens in. The file may have changed since it was saved, so a range naming
 * a bar the piece no longer has is dropped rather than seeking the play somewhere invalid.
 */
export function savedSection(
  measures: Measure[],
  from: number | null,
  to: number | null,
): Section | null {
  if (from === null || to === null) return null;
  if (from < 0 || from > to || to >= measures.length) return null;
  return { from, to };
}

/** How the loop control names the Section: printed bar numbers, a pickup bar being 0. */
export function sectionLabel(measures: Measure[], section: Section | null): string {
  if (!section) return 'Loop';
  const from = measures[section.from]?.number ?? section.from;
  const to = measures[section.to]?.number ?? section.to;
  return from === to ? `Loop bar ${from}` : `Loop bars ${from}-${to}`;
}
