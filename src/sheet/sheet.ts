// The sheet of the play screen: one endless horizontal staff line, the pitch-class palette written
// straight onto the SVG, and the amber cursor band that rides over it. Everything here is DOM and
// OSMD; the clock lives in src/play/engine.ts and only arrives as a snapshot once a frame.

import { CURSOR, INK, PAPER, colorOf, tone } from '@/look/color';
import type { Snapshot } from '@/play/engine';
import { buildScore } from '@/score/build';
import { ScoreError, type Note, type Score } from '@/score/types';
import {
  OpenSheetMusicDisplay,
  type GraphicalNote,
  type MusicSystem,
  type Note as OsmdNote,
} from 'opensheetmusicdisplay';

/** Paper kept above the top staff line, the strip ticket 12's chord bubbles sit in. */
const BUBBLE_STRIP = 28;

// The SVG groups VexFlow emits for duration marks. Everything else it draws is scaffolding.
const DURATION_GROUPS =
  '.vf-stem, .vf-beam, .vf-flag, .vf-stavetie, .vf-slur, .vf-tuplet, .vf-modifiers';

/** The ring drawn around the noteheads of the Onset the cursor stands at. */
const OUTLINE = '#ffffff';

/** A backward jump names its bar over the sheet for this long. */
const MARKER_MS = 800;

/** What a note carries besides its pitch colour. */
export type MarkKind = 'none' | 'current' | 'miss';

/** Where the cursor stands, in pixels of the unscaled sheet content. */
export interface CursorAt {
  x: number;
  /** Width of the band: the matching window, drawn at the sheet's own spacing. */
  width: number;
  onsetIndex: number;
  stepIndex: number;
}

/** Pixel geometry of one Onset, filled from the graphical model after every render. */
interface Placed {
  x: number;
  /** Right edge of the Onset's measure: what the cursor runs to before a snap. */
  measureRight: number;
  system: number;
}

type VFNote = GraphicalNote & {
  vfnoteIndex: number;
  getNoteheadSVGs(): HTMLElement[];
};

interface Box {
  top: number;
  bottom: number;
}

/**
 * One loaded sheet: its OSMD instance, its Score, the DOM it draws into and the cursor.
 * `open` gives all of it; the screen then only calls `frame` once a frame and `setDark` on a
 * theme change.
 */
export class Sheet {
  readonly osmd: OpenSheetMusicDisplay;
  score!: Score;

  private dark: boolean;
  private readonly host: HTMLElement;
  private readonly scroll: HTMLElement;
  private readonly scale: HTMLElement;
  private readonly content: HTMLElement;
  private readonly paper: HTMLElement;
  private readonly cursor: HTMLElement;
  private readonly marker: HTMLElement;

  private placed: Placed[] = [];
  private system: Box = { top: 0, bottom: 200 };
  /** Steps whose next step goes back in the written sheet: the cursor snaps instead of sliding. */
  private jumpAfter: boolean[] = [];
  private contentWidth = 1200;
  private contentHeight = 300;
  /** Pixels the content is lifted by, which leaves the bubble strip of paper above the staff. */
  private offsetY = 0;

  private misses = new Set<OsmdNote>();
  private outlined: Note[] = [];
  private drawn = { scale: 0, onset: -1, step: -1, jumpAt: -Infinity, jumpBar: 0, running: true };

  private constructor(host: HTMLElement, dark: boolean) {
    this.host = host;
    this.dark = dark;
    host.style.position = 'relative';
    host.style.overflow = 'hidden';
    this.scroll = child(host, 'width:100%;height:100%;overflow:hidden');
    this.scale = child(this.scroll, 'position:relative');
    this.content = child(this.scale, 'position:relative;width:max-content;transform-origin:0 0');
    this.paper = child(this.content, '');
    const overlay = child(this.content, 'position:absolute;inset:0;pointer-events:none');
    this.cursor = child(overlay, 'position:absolute;border-radius:12px');
    this.marker = child(
      overlay,
      'position:absolute;display:none;padding:1px 6px;border-radius:999px;' +
        'font-size:11px;font-weight:600;white-space:nowrap',
    );
    this.osmd = makeOsmd(this.paper, dark);
  }

  /** Loads the bytes, renders them on one line and builds the Score of what was rendered. */
  static async open(
    host: HTMLElement,
    bytes: Uint8Array,
    fileName: string,
    dark: boolean,
  ): Promise<Sheet> {
    const sheet = new Sheet(host, dark);
    try {
      await sheet.osmd.load(new Blob([bytes as BlobPart]), fileName);
    } catch (error) {
      throw new ScoreError('Not a MusicXML file', String(error));
    }
    if (!sheet.osmd.Sheet) throw new ScoreError('Not a MusicXML file', 'the file holds no score');
    sheet.osmd.render();
    sheet.score = buildScore(sheet.osmd.Sheet);
    sheet.layout();
    return sheet;
  }

  /** Left edge of an Onset in pixels of the unscaled content. */
  xOfOnset(index: number): number {
    return this.placed[index]?.x ?? 0;
  }

  /** Repaints the whole sheet for the other theme. The clock never hears about it. */
  setDark(dark: boolean): void {
    this.dark = dark;
    applyTheme(this.osmd, dark);
    this.osmd.render();
    this.layout();
    this.drawn.onset = -1;
    this.drawn.scale = 0;
  }

  /** Miss red or the current Onset's outline; `none` puts the pitch colour back. */
  markNote(note: Note, kind: MarkKind): void {
    const head = noteheadEl(this.osmd, note.source);
    if (!head) return;
    if (kind === 'current') {
      paintHead(head, { stroke: OUTLINE, 'stroke-width': '1.6' });
      return;
    }
    if (kind === 'miss') this.misses.add(note.source);
    else this.misses.delete(note.source);
    this.paintNote(note, head);
  }

  /**
   * One frame: the cursor to its interpolated x, the current Onset outlined, the jump marker while
   * it lasts, and the scroll that keeps the cursor about 30 % from the left edge.
   */
  frame(snap: Snapshot, windowTicks: number, now: number): void {
    this.fit();
    const at = this.cursorAt(snap.playedTick, snap.stepIndex, windowTicks);

    // While the clock runs the cursor is moved every frame, so a transition would fight it; a
    // pause, a restart and the end of the piece glide instead.
    const running = snap.state === 'running' || snap.state === 'counting-in';
    if (running !== this.drawn.running) {
      this.drawn.running = running;
      this.cursor.style.transition = running || reducedMotion() ? 'none' : 'left 220ms ease';
    }
    this.cursor.style.left = `${at.x - at.width / 2}px`;
    this.cursor.style.width = `${at.width}px`;
    this.cursor.style.top = `${this.system.top}px`;
    this.cursor.style.height = `${this.system.bottom - this.system.top}px`;

    if (at.onsetIndex !== this.drawn.onset) {
      for (const note of this.outlined) this.paintNote(note);
      this.outlined = this.score.onsets[at.onsetIndex]?.notes ?? [];
      for (const note of this.outlined) this.markNote(note, 'current');
      this.drawn.onset = at.onsetIndex;
    }

    if (at.stepIndex !== this.drawn.step) {
      if (this.jumpAfter[at.stepIndex - 1]) {
        this.drawn.jumpAt = now;
        this.drawn.jumpBar = this.barNumberAt(at.stepIndex);
      }
      this.drawn.step = at.stepIndex;
    }
    this.drawMarker(at, now);

    this.scroll.scrollLeft = at.x * this.drawn.scale - this.scroll.clientWidth * 0.3;
  }

  /**
   * Cursor x for a played tick. Inside a system it runs from one Onset to the next; before a
   * system break or a backward jump it runs to its measure's right edge, so the next step is a
   * snap and never a slide across the whole sheet.
   */
  cursorAt(playedTick: number, hint: number, windowTicks: number): CursorAt {
    const order = this.score.playOrder;
    let i = Math.min(Math.max(hint, 0), order.length - 1);
    while (i + 1 < order.length && order[i + 1]!.tick <= playedTick) i++;
    while (i > 0 && order[i]!.tick > playedTick) i--;

    const step = order[i];
    const next = order[i + 1];
    const here = this.placed[step?.onsetIndex ?? 0] ?? { x: 0, measureRight: 0, system: 0 };
    const there = next ? this.placed[next.onsetIndex] : undefined;
    const snap = !there || this.jumpAfter[i] || there.system !== here.system;
    const toX = snap ? Math.max(here.measureRight, here.x) : there.x;
    const span = next && step ? next.tick - step.tick : 0;
    const done = span > 0 ? Math.min(1, Math.max(0, (playedTick - step!.tick) / span)) : 0;
    const perTick = span > 0 ? Math.abs(toX - here.x) / span : 0;
    return {
      x: here.x + (toX - here.x) * done,
      width: Math.min(48, Math.max(12, windowTicks * 2 * perTick)),
      onsetIndex: step?.onsetIndex ?? 0,
      stepIndex: i,
    };
  }

  /** Takes only this sheet's own DOM out of the host, which may already hold the next one. */
  dispose(): void {
    this.osmd.clear();
    this.scroll.remove();
  }

  /** Pixel geometry, pitch colours and the ink tiers: everything a fresh render wipes. */
  private layout(): void {
    const unit = 10 * this.osmd.zoom;
    const rules = this.osmd.EngravingRules;
    const systems = new Map<MusicSystem, number>();
    let bottom = 200;
    for (const page of this.osmd.GraphicSheet.MusicPages) {
      for (const system of page.MusicSystems) {
        const box = system.PositionAndShape;
        systems.set(system, systems.size);
        if (systems.size === 1) {
          this.system = {
            top: (box.AbsolutePosition.y + box.BorderTop) * unit,
            bottom: (box.AbsolutePosition.y + box.BorderBottom) * unit,
          };
        }
        bottom = Math.max(bottom, (box.AbsolutePosition.y + box.BorderBottom) * unit);
      }
    }

    const placed: Placed[] = [];
    for (const onset of this.score.onsets) {
      // An Onset whose notes are all invisible carries the place of the one before it.
      let where = placed[placed.length - 1] ?? { x: 0, measureRight: 0, system: 0 };
      for (const note of onset.notes) {
        const g = rules.GNote(note.source) as VFNote | undefined;
        const measure = g?.parentVoiceEntry?.parentStaffEntry?.parentMeasure;
        if (!g || !measure) continue;
        const box = measure.PositionAndShape;
        where = {
          x: g.PositionAndShape.AbsolutePosition.x * unit,
          measureRight: (box.AbsolutePosition.x + box.BorderRight) * unit,
          system: systems.get(measure.ParentMusicSystem) ?? 0,
        };
        break;
      }
      placed.push(where);
    }
    this.placed = placed;

    const order = this.score.playOrder;
    this.jumpAfter = order.map((step, i) => {
      const next = order[i + 1];
      if (!next) return false;
      return this.score.onsets[next.onsetIndex]!.tick < this.score.onsets[step.onsetIndex]!.tick;
    });

    for (const onset of this.score.onsets) for (const note of onset.notes) this.paintNote(note);
    applyTiers(this.paper, this.dark);

    // Paper above the top staff line is dead space apart from the strip the bubbles need. The lift
    // stops short of the highest label, so the tempo mark and the bar numbers survive it.
    let topLabel = this.system.top;
    for (const text of this.paper.querySelectorAll('svg text')) {
      const box = (text as SVGGraphicsElement).getBBox();
      if (box.y < topLabel) topLabel = box.y;
    }
    this.offsetY = Math.max(0, Math.min(this.system.top - BUBBLE_STRIP, topLabel - 4));
    this.contentHeight = bottom - this.offsetY + 8;
    this.contentWidth = Number(this.paper.querySelector('svg')?.getAttribute('width')) || 1200;

    this.cursor.style.background = `color-mix(in srgb, ${tone(CURSOR, this.dark)} 26%, transparent)`;
    this.cursor.style.boxShadow = `inset 0 0 0 1px color-mix(in srgb, ${tone(CURSOR, this.dark)} 55%, transparent)`;
    this.marker.style.background = tone(INK.duration, this.dark);
    this.marker.style.color = tone(PAPER, this.dark);
  }

  /** Scales the content so the staff line fills the sheet block, and lifts the dead paper away. */
  private fit(): void {
    const scale = Math.min(1.2, Math.max(0.42, this.host.clientHeight / this.contentHeight));
    if (Math.abs(scale - this.drawn.scale) < 0.005) return;
    this.content.style.transform = `scale(${scale}) translateY(${-this.offsetY}px)`;
    this.scale.style.width = `${this.contentWidth * scale}px`;
    this.scale.style.height = `${this.contentHeight * scale}px`;
    this.drawn.scale = scale;
  }

  private drawMarker(at: CursorAt, now: number): void {
    const age = now - this.drawn.jumpAt;
    if (age >= MARKER_MS) {
      if (this.marker.style.display !== 'none') this.marker.style.display = 'none';
      return;
    }
    this.marker.style.display = 'block';
    this.marker.style.opacity = String(1 - age / MARKER_MS);
    this.marker.style.left = `${at.x - 20}px`;
    this.marker.style.top = `${Math.max(this.system.top - 18, 0)}px`;
    this.marker.textContent = `↺ bar ${this.drawn.jumpBar}`;
  }

  private barNumberAt(stepIndex: number): number {
    const step = this.score.playOrder[stepIndex];
    const onset = step ? this.score.onsets[step.onsetIndex] : undefined;
    return onset ? (this.score.measures[onset.measureIndex]?.number ?? 0) : 0;
  }

  /** The pitch colour of a note, or the miss red once it has been marked. */
  private paintNote(note: Note, head = noteheadEl(this.osmd, note.source)): void {
    if (!head) return;
    const colour = this.misses.has(note.source)
      ? tone(INK.miss, this.dark)
      : colorOf(note.midi, 'muted', this.dark);
    paintHead(head, { fill: colour, stroke: colour, 'stroke-width': null, opacity: null });
  }
}

function child(parent: HTMLElement, style: string): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = style;
  parent.append(el);
  return el;
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function makeOsmd(host: HTMLElement, dark: boolean): OpenSheetMusicDisplay {
  const osmd = new OpenSheetMusicDisplay(host, {
    backend: 'svg',
    autoResize: false,
    drawCredits: false,
    drawPartNames: false,
    drawTitle: false,
    drawSubtitle: false,
    drawComposer: false,
    drawLyricist: false,
    // Set before `load`, which is what makes the whole piece one endless horizontal line.
    renderSingleHorizontalStaffline: true,
  });
  applyTheme(osmd, dark);
  return osmd;
}

/** The two ink tiers and the paper, as engraving rules. Everything else is a DOM pass. */
function applyTheme(osmd: OpenSheetMusicDisplay, dark: boolean): void {
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
  rules.MetronomeMarkYShift = 2.5;
  // Nothing prints above the staff but the tempo mark, so the page margin is dead space.
  rules.PageTopMargin = 0;
}

/** Lifts the duration marks out of the scaffolding tier. Runs after every render. */
function applyTiers(host: HTMLElement, dark: boolean): void {
  const colour = tone(INK.duration, dark);
  const svg = host.querySelector('svg');
  if (!svg) return;
  for (const group of svg.querySelectorAll(DURATION_GROUPS)) {
    for (const el of group.querySelectorAll('path, rect, line, polygon, text')) {
      if (el.getAttribute('fill') !== 'none') el.setAttribute('fill', colour);
      if (el.hasAttribute('stroke') && el.getAttribute('stroke') !== 'none') {
        el.setAttribute('stroke', colour);
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
