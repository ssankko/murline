// What a rendered sheet is painted with, shared by the play screen and the Preview: the ink tiers
// as engraving rules, and the way to reach one notehead. The marks VexFlow paints in ink of its
// own are lifted to the duration tier by the `.sheet-paper` rules of src/index.css. Nothing here
// knows about a cursor or a play.

import { INK, PAPER, tone } from '@/look/color';
import {
  OpenSheetMusicDisplay,
  TextAlignmentEnum,
  type GraphicalNote,
  type Note as OsmdNote,
} from 'opensheetmusicdisplay';

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
  // The ink every glyph VexFlow draws without a colour of its own falls back to: clefs, the key and
  // time signatures, barlines, the brace and the rehearsal marks.
  rules.DefaultColorMusic = scaffold;
  rules.StaffLineColor = scaffold;
  rules.LedgerLineColorDefault = scaffold;
  rules.DefaultColorLabel = scaffold;
  rules.DefaultColorStem = duration;
  rules.DefaultColorRest = duration;
  rules.DefaultColorNotehead = duration;
  // The credits are only printed by the Preview, and they read as ink rather than as scaffolding.
  rules.DefaultColorTitle = duration;
  rules.MetronomeMarkYShift = 2.5;
  // A tempo word is centred on its anchor by default, which walks it left over the metronome mark
  // VexFlow draws at the head of the stave. Aligned left, the word starts clear of the mark.
  rules.TempoExpressionTextAlignment = TextAlignmentEnum.LeftBottom;
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
