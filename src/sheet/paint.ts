// What a rendered sheet is painted with, shared by the play screen and the Preview: the ink tiers
// as engraving rules and as the DOM pass a render does not cover, and the way to reach one
// notehead. Nothing here knows about a cursor or a play.

import { INK, PAPER, tone } from '@/look/color';
import { OpenSheetMusicDisplay, type GraphicalNote, type Note as OsmdNote } from 'opensheetmusicdisplay';

// The SVG groups VexFlow emits for duration marks. Everything else it draws is scaffolding.
const DURATION_GROUPS =
  '.vf-stem, .vf-beam, .vf-flag, .vf-stavetie, .vf-slur, .vf-tuplet, .vf-modifiers';

/** A graphical note as VexFlow leaves it: the noteheads it drew, and where they sit in the array. */
export type VFNote = GraphicalNote & {
  vfnoteIndex: number;
  getNoteheadSVGs(): HTMLElement[];
};

/** The two ink tiers and the paper, as engraving rules. Everything else is a DOM pass. */
export function applyTheme(osmd: OpenSheetMusicDisplay, dark: boolean): void {
  const rules = osmd.EngravingRules;
  const scaffold = tone(INK.scaffolding, dark);
  const duration = tone(INK.duration, dark);
  rules.ColorStemsLikeNoteheads = false;
  rules.ColorBeams = false;
  rules.PageBackgroundColor = tone(PAPER, dark);
  rules.StaffLineColor = scaffold;
  rules.LedgerLineColorDefault = scaffold;
  rules.DefaultColorLabel = scaffold;
  rules.DefaultColorStem = duration;
  rules.DefaultColorRest = duration;
  rules.DefaultColorNotehead = duration;
  // The credits are only printed by the Preview, and they read as ink rather than as scaffolding.
  rules.DefaultColorTitle = duration;
  rules.MetronomeMarkYShift = 2.5;
}

/** Lifts the duration marks out of the scaffolding tier. Runs after every render. */
export function applyTiers(host: HTMLElement, dark: boolean): void {
  const colour = tone(INK.duration, dark);
  for (const svg of host.querySelectorAll('svg')) {
    for (const group of svg.querySelectorAll(DURATION_GROUPS)) {
      for (const el of group.querySelectorAll('path, rect, line, polygon, text')) {
        if (el.getAttribute('fill') !== 'none') el.setAttribute('fill', colour);
        if (el.hasAttribute('stroke') && el.getAttribute('stroke') !== 'none') {
          el.setAttribute('stroke', colour);
        }
      }
    }
  }
}

/** Notehead group of one note, picked out of its chord's group by `vfnoteIndex`. */
export function noteheadEl(
  osmd: OpenSheetMusicDisplay,
  note: OsmdNote,
): HTMLElement | undefined {
  const g = osmd.EngravingRules.GNote(note) as VFNote | undefined;
  if (!g?.getNoteheadSVGs) return undefined;
  const heads = g.getNoteheadSVGs();
  return heads[g.vfnoteIndex] ?? heads[0];
}

/** A notehead group carries no paint of its own, so every write goes to its child paths. */
export function paintHead(head: HTMLElement, attrs: Record<string, string | null>): void {
  for (const path of head.children) {
    for (const name in attrs) {
      const value = attrs[name];
      if (value === null) path.removeAttribute(name);
      else path.setAttribute(name, value);
    }
  }
}
