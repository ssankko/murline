// Where the moments of a rendered sheet stand, read off the OSMD graphical model after a render,
// and what a click on the paper means by them. Nothing here knows about a cursor, a scroll or the
// DOM a sheet draws into, so one horizontal line and a page of many systems read the same way.

import type { SeekTarget } from '@/play/engine';
import { ticksOf, type Score } from '@/score/types';
import type { MusicSystem, OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import type { VFNote } from './paint';

/** Pixel geometry of one Onset, filled from the graphical model after every render. */
export interface Placed {
  x: number;
  /** Right edge of the Onset's measure: what the cursor runs to before a snap. */
  measureRight: number;
  system: number;
}

/**
 * One moment of the sheet held by rests alone: a place the cursor may stand at that no Onset names.
 * The bar and the ticks past its opening line are what a seek to it asks for.
 */
export interface RestMoment {
  x: number;
  measure: number;
  into: number;
  system: number;
}

/** Where a click on the paper landed: what to seek to, and the bar it fell in. */
export interface SheetHit {
  seek: SeekTarget;
  measure: number;
}

/** The left and right edge of something drawn on the paper, in unscaled pixels. */
export interface Span {
  left: number;
  right: number;
}

/** Everything one render says about where the moments of the sheet stand, in unscaled pixels. */
export interface Placement {
  /** One record per Onset of the Score, in written order. */
  placed: Placed[];
  /** Left and right edge of each bar, by measure index, for the Section a drag picks. */
  boxes: (Span | undefined)[];
  /** Rest moments in no order, which a click is measured against alongside the Onsets. */
  rests: RestMoment[];
  /**
   * Pixels per tick of a sheet spaced by time, one for the whole of it, which the cursor band
   * takes its width from. Zero while the sheet is spaced by its engraving.
   */
  pxPerTick: number;
}

/** The systems of the sheet in reading order, whatever pages OSMD broke them over. */
export function systemsOf(osmd: OpenSheetMusicDisplay): MusicSystem[] {
  return osmd.GraphicSheet.MusicPages.flatMap((page) => page.MusicSystems);
}

/** Reads the place of every Onset, bar and rest moment out of the render just drawn. */
export function place(osmd: OpenSheetMusicDisplay, score: Score, proportional: boolean): Placement {
  const unit = 10 * osmd.zoom;
  const rules = osmd.EngravingRules;
  const systems = new Map<MusicSystem, number>(systemsOf(osmd).map((system, i) => [system, i]));

  const placed: Placed[] = [];
  const boxes: (Span | undefined)[] = [];
  for (const onset of score.onsets) {
    // An Onset whose notes are all invisible carries the place of the one before it.
    let where = placed[placed.length - 1] ?? { x: 0, measureRight: 0, system: 0 };
    for (const note of onset.notes) {
      const g = rules.GNote(note.source) as VFNote | undefined;
      const measure = g?.parentVoiceEntry?.parentStaffEntry?.parentMeasure;
      if (!g || !measure) continue;
      const box = measure.PositionAndShape;
      // Spaced by time an Onset stands at its own notehead, which `spacing.ts` put at its share
      // of the measure; the engraved place is the whole staff entry, accidentals and all.
      const head = proportional ? headX(g) : undefined;
      const engraved = g.PositionAndShape.AbsolutePosition.x * unit;
      where = {
        x: head === undefined ? engraved : head * osmd.zoom,
        measureRight: (box.AbsolutePosition.x + box.BorderRight) * unit,
        system: systems.get(measure.ParentMusicSystem) ?? 0,
      };
      boxes[onset.measureIndex] = {
        left: (box.AbsolutePosition.x + box.BorderLeft) * unit,
        right: where.measureRight,
      };
      break;
    }
    placed.push(where);
  }
  return {
    placed,
    boxes,
    rests: restsOf(osmd, score, systems, proportional),
    pxPerTick: proportional ? perTickOf(score.onsets, placed) : 0,
  };
}

/**
 * What a click at an x of the unscaled content means: the moment nearest it, however far away,
 * and the bar the click fell in, which is the Onset before it or the next one past that bar's
 * edge. A rest that beats every notehead to the click is asked for by its place in its bar; equal
 * distances go to the Onset. Given a system, only its moments are measured: a page of many
 * systems asks with the one the click fell in.
 */
export function hitAt(
  x: number,
  onsets: readonly { measureIndex: number }[],
  { placed, rests }: Pick<Placement, 'placed' | 'rests'>,
  system?: number,
): SheetHit | null {
  // The Onsets of one system stand together in written order, so a system is a stretch of them.
  const lo = system === undefined ? 0 : placed.findIndex((at) => at.system === system);
  const hi =
    system === undefined ? onsets.length - 1 : placed.findLastIndex((at) => at.system === system);
  if (lo < 0 || hi < lo) return null;
  let i = lo;
  while (i + 1 <= hi && placed[i + 1]!.x <= x) i++;
  const next = i + 1 <= hi ? i + 1 : i;
  const near = Math.abs(placed[next]!.x - x) < Math.abs(placed[i]!.x - x) ? next : i;
  const bar = x > placed[i]!.measureRight ? next : i;
  let closest = Math.abs(placed[near]!.x - x);
  let rest: RestMoment | undefined;
  for (const moment of rests) {
    if (system !== undefined && moment.system !== system) continue;
    if (Math.abs(moment.x - x) >= closest) continue;
    closest = Math.abs(moment.x - x);
    rest = moment;
  }
  const seek = rest ? { measure: rest.measure, into: rest.into } : { onset: near };
  return { seek, measure: onsets[bar]!.measureIndex };
}

/**
 * Width of the cursor band: the matching window either side of the cursor at the sheet's pixels
 * per tick, and never thinner than a hairline.
 */
export function bandWidth(windowTicks: number, pxPerTick: number): number {
  return Math.max(2, windowTicks * 2 * pxPerTick);
}

/**
 * Every moment of the sheet that rests alone hold, in pixels of the unscaled content. A tick some
 * staff sounds at is an Onset already, and a click there means the Onset, so those are left out.
 */
function restsOf(
  osmd: OpenSheetMusicDisplay,
  score: Score,
  systems: Map<MusicSystem, number>,
  proportional: boolean,
): RestMoment[] {
  const unit = 10 * osmd.zoom;
  const sounding = new Set(score.onsets.map((onset) => onset.tick));
  const taken = new Set<number>();
  const rests: RestMoment[] = [];
  osmd.GraphicSheet.MeasureList.forEach((staves, index) => {
    const measure = score.measures[index];
    if (!measure) return;
    for (const staff of staves) {
      for (const entry of staff?.staffEntries ?? []) {
        if (!entry.hasOnlyRests()) continue;
        const into = ticksOf(entry.relInMeasureTimestamp.RealValue);
        const tick = measure.startTick + into;
        if (sounding.has(tick) || taken.has(tick)) continue;
        taken.add(tick);
        // Spaced by time a rest stands at its own glyph, as an Onset stands at its notehead.
        const g = entry.graphicalVoiceEntries[0]?.notes[0] as VFNote | undefined;
        const head = proportional && g ? headX(g) : undefined;
        const engraved = entry.PositionAndShape.AbsolutePosition.x * unit;
        rests.push({
          x: head === undefined ? engraved : head * osmd.zoom,
          measure: index,
          into,
          system: systems.get(staff!.ParentMusicSystem) ?? 0,
        });
      }
    }
  });
  return rests;
}

/** Left edge of the notehead VexFlow drew for a note, in pixels of the unzoomed sheet. */
function headX(note: VFNote): number | undefined {
  return (note as { vfnote?: [{ getAbsoluteX(): number }] }).vfnote?.[0]?.getAbsoluteX();
}

/**
 * The one speed a sheet spaced by time runs at: every gap that stays inside a measure over the
 * ticks it covers. Gaps across a bar line are left out, the bar line and its instructions being
 * paper no duration asks for. A bar too crowded for the width it got keeps VexFlow's packing and
 * runs at a speed of its own, so this is a mean; only the band's width reads it, the cursor itself
 * standing between the Onsets as they were drawn.
 */
function perTickOf(
  onsets: readonly { tick: number; measureIndex: number }[],
  placed: Placed[],
): number {
  let px = 0;
  let ticks = 0;
  for (let i = 1; i < onsets.length; i++) {
    if (onsets[i]!.measureIndex !== onsets[i - 1]!.measureIndex) continue;
    px += placed[i]!.x - placed[i - 1]!.x;
    ticks += onsets[i]!.tick - onsets[i - 1]!.tick;
  }
  return ticks > 0 ? px / ticks : 0;
}
