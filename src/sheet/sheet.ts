// The sheet of the play screen: one endless horizontal staff line, the pitch-class palette written
// straight onto the SVG, and the amber cursor band that rides over it. Everything here is DOM and
// OSMD; the clock lives in src/play/engine.ts and only arrives as a snapshot once a frame.

import { clamp } from '@/lib/utils';
import { CURSOR, INK, PAPER, colorOf, tone } from '@/look/color';
import { reducedMotion } from '@/look/motion';
import type { SeekTarget, Snapshot } from '@/play/engine';
import type { Section } from '@/play/section';
import { isInactiveHand, type HandsSetting } from '@/play/settings';
import { buildScore } from '@/score/build';
import { loadInto } from '@/score/load';
import { analyzeHarmony } from '@/score/harmony';
import type { Note, PlayStep, Score } from '@/score/types';
import {
  OpenSheetMusicDisplay,
  type MusicSystem,
  type Note as OsmdNote,
} from 'opensheetmusicdisplay';
import { applyTheme, applyTiers, noteheadEl, paintHead, type VFNote } from './paint';

/** Paper kept above the top staff line, the strip the chord bubbles sit in. */
const BUBBLE_STRIP = 28;

/** Height of one row of bubbles, half the strip. */
const BUBBLE_ROW = 13;

/** Clear paper kept between two bubbles of one row. */
const BUBBLE_GAP = 6;

/**
 * The ring drawn around the noteheads of the Onset the cursor stands at. It reads as paper
 * cleared out of the amber cursor band, so it works on either paper.
 */
const OUTLINE = '#ffffff';

/** A backward jump names its bar over the sheet for this long. */
const MARKER_MS = 800;

/** How far from an Onset a click still means that Onset and not its bar, in unscaled pixels. */
const NOTE_REACH = 11;

/** Pointer travel that turns a click into a Section drag, in screen pixels. */
const DRAG_SLOP = 4;

/** While Running a scroll detaches the view, and it snaps back this long after the last input. */
const DETACH_MS = 2000;

/** How long the cursor takes to slide when it is not being moved by the clock. */
const GLIDE_MS = 220;

/** The end of a practice: the cursor band fades away over this long and comes back at the start. */
const FINISH_MS = 400;

/** What a note carries besides its pitch colour. */
type MarkKind = 'none' | 'current' | 'miss';

/** Where the cursor stands, in pixels of the unscaled sheet content. */
interface CursorAt {
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

/** Where a click on the paper landed: what to seek to, and the bar it fell in. */
interface SheetHit {
  seek: SeekTarget;
  measure: number;
}

/** A pointer drag on the paper: picking a Section, or moving one of its ends. */
interface Drag {
  end: 'pick' | 'from' | 'to';
  /** The bar the Section keeps while the other end follows the pointer. */
  anchor: number;
  hit: SheetHit;
  x: number;
  moved: boolean;
}

/** The left and right edge of one bar, in unscaled pixels. */
interface BarBox {
  left: number;
  right: number;
}

/**
 * One loaded sheet: its OSMD instance, its Score, the DOM it draws into and the cursor.
 * `open` gives all of it; the screen then only calls `frame` once a frame and `setDark` on a
 * theme change.
 */
export class Sheet {
  readonly osmd: OpenSheetMusicDisplay;
  score!: Score;
  /** A click on the paper that picked no Section: the screen decides what a seek does. */
  onSeek: ((target: SeekTarget) => void) | null = null;
  /** A drag picked or resized the Section, or the × cleared it. */
  onSection: ((section: Section | null) => void) | null = null;

  private dark: boolean;
  private readonly host: HTMLElement;
  private readonly scroll: HTMLElement;
  private readonly scale: HTMLElement;
  private readonly content: HTMLElement;
  private readonly paper: HTMLElement;
  private readonly cursor: HTMLElement;
  private readonly marker: HTMLElement;
  private readonly bubbles: HTMLElement;
  private bubbleEls: HTMLElement[] = [];
  /** The Section: one tinted band and a handle at each end, the end one carrying the ×. */
  private readonly tint: HTMLElement;
  private readonly handles: [HTMLElement, HTMLElement];
  private readonly clear: HTMLElement;
  /** Takes every listener this sheet put on the host off again. */
  private readonly listeners = new AbortController();

  private section: Section | null = null;
  private drag: Drag | null = null;
  /** Wall-clock time of the last free scroll: the view snaps back two seconds after it. */
  private scrolledAt = -Infinity;
  /** The played timeline the cursor reads; the engine swaps it when Loop goes on. */
  private walk: PlayStep[] = [];
  /** Left and right edge of each bar in unscaled pixels, for the Section a drag picks. */
  private boxes: (BarBox | undefined)[] = [];

  private placed: Placed[] = [];
  private system = { top: 0, bottom: 200 };
  /** The top staff line of the first system: the bubble strip ends here. */
  private stafflineY = BUBBLE_STRIP;
  /** Steps whose next step goes back in the written sheet: the cursor snaps instead of sliding. */
  private jumpAfter: boolean[] = [];
  private contentWidth = 1200;
  private contentHeight = 300;
  /** Pixels the content is lifted by, which leaves the bubble strip of paper above the staff. */
  private offsetY = 0;

  private misses = new Set<OsmdNote>();
  /** Which hand the play expects; the other hand's noteheads read as scaffolding. */
  private hands: HandsSetting = 'both';
  private outlined: Note[] = [];
  private drawn = {
    scale: 0,
    onset: -1,
    step: -1,
    tick: 0,
    jumpAt: -Infinity,
    jumpBar: 0,
    running: true,
    glide: false,
    glideUntil: -Infinity,
  };

  private constructor(host: HTMLElement, dark: boolean) {
    this.host = host;
    this.dark = dark;
    host.style.position = 'relative';
    host.style.overflow = 'hidden';
    this.scroll = child(host, 'width:100%;height:100%;overflow:hidden');
    this.scale = child(this.scroll, 'position:relative');
    this.content = child(this.scale, 'position:relative;width:max-content;transform-origin:0 0');
    this.paper = child(this.content, '');
    // The class carries the fade a recolouring rides on; src/index.css holds it.
    this.paper.className = 'sheet-paper';
    const overlay = child(this.content, 'position:absolute;inset:0;pointer-events:none');
    this.bubbles = child(overlay, 'position:absolute;inset:0');
    this.tint = child(overlay, 'position:absolute;display:none');
    this.handles = [
      child(overlay, 'position:absolute;display:none;width:5px;cursor:ew-resize;pointer-events:auto'),
      child(overlay, 'position:absolute;display:none;width:5px;cursor:ew-resize;pointer-events:auto'),
    ];
    this.clear = child(
      this.handles[1],
      'position:absolute;top:-9px;left:-6px;width:16px;height:16px;border-radius:999px;' +
        'display:flex;align-items:center;justify-content:center;cursor:pointer;' +
        'font-size:11px;line-height:1;font-weight:700',
    );
    this.clear.textContent = '×';
    this.cursor = child(overlay, 'position:absolute;border-radius:12px');
    this.cursor.className = 'sheet-cursor';
    this.marker = child(
      overlay,
      'position:absolute;display:none;padding:1px 6px;border-radius:999px;' +
        'font-size:11px;font-weight:600;white-space:nowrap',
    );
    this.osmd = makeOsmd(this.paper, dark);

    const { signal } = this.listeners;
    host.addEventListener('pointerdown', (event) => this.down(event), { signal });
    host.addEventListener('pointermove', (event) => this.move(event), { signal });
    host.addEventListener('pointerup', (event) => this.up(event), { signal });
    // The paper never scrolls by itself: a drag on it selects, and the wheel moves the view.
    host.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const by = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
        this.scroll.scrollLeft += by;
        this.scrolledAt = performance.now();
      },
      { passive: false, signal },
    );
  }

  /** Loads the bytes, renders them on one line and builds the Score of what was rendered. */
  static async open(
    host: HTMLElement,
    bytes: Uint8Array,
    fileName: string,
    dark: boolean,
  ): Promise<Sheet> {
    const sheet = new Sheet(host, dark);
    await loadInto(sheet.osmd, bytes, fileName);
    sheet.osmd.render();
    sheet.score = buildScore(sheet.osmd.Sheet);
    sheet.score.harmony = analyzeHarmony(sheet.score);
    sheet.layout();
    return sheet;
  }

  /** Left edge of an Onset in pixels of the unscaled content. */
  xOfOnset(index: number): number {
    return this.placed[index]?.x ?? 0;
  }

  /** Follows the engine's walk, so the cursor slides along the timeline the clock runs. */
  setWalk(walk: PlayStep[]): void {
    if (walk === this.walk) return;
    this.walk = walk;
    this.markJumps();
    this.drawn.step = -1;
  }

  /** Draws the Section, or takes it off the paper. The screen owns whether there is one. */
  setSection(section: Section | null): void {
    this.section = section;
    this.drawSection();
  }

  /**
   * What a click at a screen x means: the Onset within reach of it, else the bar it fell in. The
   * bar is the one the Onset before the click belongs to, or the next one past that bar's edge.
   */
  private hitAt(clientX: number): SheetHit | null {
    const x = this.contentX(clientX);
    const onsets = this.score.onsets;
    if (onsets.length === 0) return null;
    let i = 0;
    while (i + 1 < onsets.length && this.placed[i + 1]!.x <= x) i++;
    const next = i + 1 < onsets.length ? i + 1 : i;
    const near = Math.abs(this.placed[next]!.x - x) < Math.abs(this.placed[i]!.x - x) ? next : i;
    if (Math.abs(this.placed[near]!.x - x) <= NOTE_REACH) {
      return { seek: { onset: near }, measure: onsets[near]!.measureIndex };
    }
    const bar = x > this.placed[i]!.measureRight ? next : i;
    const measure = onsets[bar]!.measureIndex;
    return { seek: { measure }, measure };
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

  /** Takes the pitch colour off the hand the play no longer expects, and puts it back. */
  setHands(hands: HandsSetting): void {
    if (hands === this.hands) return;
    this.hands = hands;
    for (const onset of this.score.onsets) for (const note of onset.notes) this.paintNote(note);
    for (const note of this.outlined) this.markNote(note, 'current');
  }

  /** The miss grey or the current Onset's outline; `none` puts the pitch colour back. */
  markNote(note: Note, kind: MarkKind): void {
    const head = noteheadEl(this.osmd, note.source);
    if (!head) return;
    if (kind === 'current') {
      paintHead(head, { stroke: OUTLINE, 'stroke-width': '1.2', 'paint-order': 'stroke' });
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

    const running = snap.state === 'running' || snap.state === 'counting-in';
    if (running !== this.drawn.running) {
      this.drawn.running = running;
      // Play snaps the view to the cursor, whatever the reader scrolled to while it was still.
      this.scrolledAt = -Infinity;
    }
    // A loop wrap runs the cursor back over the sheet, so the frames after it glide. A written
    // repeat snaps instead: `cursorAt` has already run the cursor to the measure's right edge.
    if (running && snap.playedTick < this.drawn.tick && !this.jumpAfter[this.drawn.step]) {
      this.drawn.glideUntil = now + GLIDE_MS;
    }
    this.drawn.tick = snap.playedTick;
    // While the clock runs forward the cursor is moved every frame, so a transition would fight it.
    const glide = (!running || now < this.drawn.glideUntil) && !reducedMotion();
    if (glide !== this.drawn.glide) {
      this.drawn.glide = glide;
      this.cursor.style.transition = glide ? `left ${GLIDE_MS}ms ease` : 'none';
    }
    this.cursor.style.left = `${at.x - at.width / 2}px`;
    this.cursor.style.width = `${at.width}px`;
    this.cursor.style.top = `${this.system.top}px`;
    this.cursor.style.height = `${this.system.bottom - this.system.top}px`;

    if (at.onsetIndex !== this.drawn.onset) {
      for (const note of this.outlined) this.paintNote(note);
      this.outlined = this.score.onsets[at.onsetIndex]?.notes ?? [];
      for (const note of this.outlined) this.markNote(note, 'current');
      this.dimBubbles(at.onsetIndex);
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

    // The view is the reader's while the play stands still, and again for two seconds after a
    // scroll during one; the rest of the time it holds the cursor 30 % from the left edge.
    if (running && now - this.scrolledAt >= DETACH_MS) {
      this.scroll.scrollLeft = at.x * this.drawn.scale - this.scroll.clientWidth * 0.3;
    }
  }

  /**
   * Cursor x for a played tick. Inside a system it runs from one Onset to the next; before a
   * system break or a backward jump it runs to its measure's right edge, so the next step is a
   * snap and never a slide across the whole sheet.
   */
  cursorAt(playedTick: number, hint: number, windowTicks: number): CursorAt {
    const order = this.walk;
    let i = clamp(hint, 0, order.length - 1);
    while (i + 1 < order.length && order[i + 1]!.tick <= playedTick) i++;
    while (i > 0 && order[i]!.tick > playedTick) i--;

    const step = order[i];
    const next = order[i + 1];
    const here = this.placed[step?.onsetIndex ?? 0] ?? { x: 0, measureRight: 0, system: 0 };
    const there = next ? this.placed[next.onsetIndex] : undefined;
    const snap = !there || this.jumpAfter[i] || there.system !== here.system;
    const toX = snap ? Math.max(here.measureRight, here.x) : there.x;
    const span = next && step ? next.tick - step.tick : 0;
    const done = span > 0 ? clamp((playedTick - step!.tick) / span, 0, 1) : 0;
    const perTick = span > 0 ? Math.abs(toX - here.x) / span : 0;
    return {
      x: here.x + (toX - here.x) * done,
      width: Math.max(2, windowTicks * 2 * perTick),
      onsetIndex: step?.onsetIndex ?? 0,
      stepIndex: i,
    };
  }

  /** The end of a practice: the cursor band fades out and comes back at the start point. */
  finish(): void {
    if (reducedMotion()) return;
    this.cursor.animate([{ opacity: 1 }, { opacity: 0, offset: 0.75 }, { opacity: 1 }], FINISH_MS);
  }

  /** Takes only this sheet's own DOM out of the host, which may already hold the next one. */
  dispose(): void {
    this.listeners.abort();
    this.osmd.clear();
    this.scroll.remove();
  }

  /** Unscaled content x of a screen x, whatever the view is scrolled and scaled to. */
  private contentX(clientX: number): number {
    const left = this.host.getBoundingClientRect().left;
    return (clientX - left + this.scroll.scrollLeft) / (this.drawn.scale || 1);
  }

  /** A press on a handle moves that end of the Section; a press on the paper starts a fresh one. */
  private down(event: PointerEvent): void {
    if (event.button !== 0) return;
    if (event.target === this.clear) {
      this.onSection?.(null);
      return;
    }
    const hit = this.hitAt(event.clientX);
    if (!hit) return;
    const end =
      event.target === this.handles[0] ? 'from' : event.target === this.handles[1] ? 'to' : 'pick';
    const anchor =
      end === 'from' ? (this.section?.to ?? hit.measure) : (this.section?.from ?? hit.measure);
    this.drag = { end, anchor, hit, x: event.clientX, moved: end !== 'pick' };
    (event.target as Element).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }

  /** A drag across the paper picks whole bars: one bar while it stays in one, more as it leaves. */
  private move(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.buttons === 0) return;
    if (!drag.moved && Math.abs(event.clientX - drag.x) < DRAG_SLOP) return;
    drag.moved = true;
    const hit = this.hitAt(event.clientX);
    if (!hit) return;
    this.onSection?.({ from: drag.anchor, to: hit.measure });
  }

  private up(event: PointerEvent): void {
    const drag = this.drag;
    this.drag = null;
    if (drag && !drag.moved && event.target !== this.clear) this.onSeek?.(drag.hit.seek);
  }

  /** The tinted band over the Section's bars, with a handle at each end of it. */
  private drawSection(): void {
    const section = this.section;
    const from = this.boxes[section?.from ?? -1];
    const to = this.boxes[section?.to ?? -1];
    const show = section && from && to;
    this.tint.style.display = show ? 'block' : 'none';
    for (const handle of this.handles) handle.style.display = show ? 'block' : 'none';
    if (!show) return;
    const top = this.system.top;
    const height = this.system.bottom - top;
    const ink = tone(INK.duration, this.dark);
    this.tint.style.cssText =
      `position:absolute;display:block;left:${from.left}px;top:${top}px;` +
      `width:${to.right - from.left}px;` +
      `height:${height}px;background:color-mix(in srgb, ${ink} 9%, transparent)`;
    for (const [i, handle] of this.handles.entries()) {
      handle.style.left = `${(i === 0 ? from.left : to.right) - 2}px`;
      handle.style.top = `${top}px`;
      handle.style.height = `${height}px`;
      handle.style.background = ink;
    }
    this.clear.style.background = ink;
    this.clear.style.color = tone(PAPER, this.dark);
  }

  /** Steps the cursor snaps after: the step it leads to stands earlier in the written sheet. */
  private markJumps(): void {
    this.jumpAfter = this.walk.map((step, i) => {
      const next = this.walk[i + 1];
      if (!next) return false;
      return this.score.onsets[next.onsetIndex]!.tick < this.score.onsets[step.onsetIndex]!.tick;
    });
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
          this.stafflineY = (system.StaffLines[0]?.PositionAndShape.AbsolutePosition.y ?? 0) * unit;
          this.system = {
            top: (box.AbsolutePosition.y + box.BorderTop) * unit,
            bottom: (box.AbsolutePosition.y + box.BorderBottom) * unit,
          };
        }
        bottom = Math.max(bottom, (box.AbsolutePosition.y + box.BorderBottom) * unit);
      }
    }

    const placed: Placed[] = [];
    this.boxes = [];
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
        this.boxes[onset.measureIndex] = {
          left: (box.AbsolutePosition.x + box.BorderLeft) * unit,
          right: where.measureRight,
        };
        break;
      }
      placed.push(where);
    }
    this.placed = placed;

    if (this.walk.length === 0) this.walk = this.score.playOrder;
    this.markJumps();

    for (const onset of this.score.onsets) for (const note of onset.notes) this.paintNote(note);
    applyTiers(this.paper, this.dark);

    // Paper above the top staff line is dead space apart from the strip the bubbles need. The lift
    // stops short of the highest label, so the tempo mark and the bar numbers survive it.
    let topLabel = this.stafflineY;
    for (const text of this.paper.querySelectorAll('svg text')) {
      const box = (text as SVGGraphicsElement).getBBox();
      if (box.y < topLabel) topLabel = box.y;
    }
    this.offsetY = Math.max(0, Math.min(this.stafflineY - BUBBLE_STRIP, topLabel - 4));
    this.contentHeight = bottom - this.offsetY + 8;
    this.contentWidth = Number(this.paper.querySelector('svg')?.getAttribute('width')) || 1200;

    this.placeBubbles();
    this.drawSection();

    this.cursor.style.background = `color-mix(in srgb, ${tone(CURSOR, this.dark)} 26%, transparent)`;
    this.cursor.style.boxShadow = `inset 0 0 0 1px color-mix(in srgb, ${tone(CURSOR, this.dark)} 55%, transparent)`;
    this.marker.style.background = tone(INK.duration, this.dark);
    this.marker.style.color = tone(PAPER, this.dark);
  }

  /**
   * One bubble per chord event of the Score, standing over its Onset in the strip of paper above
   * the top staff. A bubble that would print over the one before it drops to a second row rather
   * than sliding away from its Onset. Widths are measured unscaled, as the x values are, so the
   * rows hold at every scale.
   */
  private placeBubbles(): void {
    this.bubbles.replaceChildren();
    this.bubbleEls = this.score.harmony.map((event) => {
      const el = child(
        this.bubbles,
        'position:absolute;transform:translateX(-50%);display:flex;align-items:baseline;' +
          `gap:4px;white-space:nowrap;font-size:11px;font-weight:600;line-height:${BUBBLE_ROW}px`,
      );
      el.className = 'chord-bubble';
      el.style.left = `${this.xOfOnset(event.onsetIndex)}px`;
      el.style.color = tone(INK.duration, this.dark);
      const degree = document.createElement('i');
      degree.style.cssText = `font-style:normal;font-weight:400;font-size:8.5px;line-height:${BUBBLE_ROW}px`;
      degree.style.color = tone(INK.scaffolding, this.dark);
      degree.textContent = event.degree;
      el.append(event.absolute, degree);
      return el;
    });

    // Two rows fill the strip, the lower one stopping just short of the top staff line. A piece
    // whose paper above the staff is thinner than the strip keeps both rows on the paper it has.
    const top = Math.max(this.offsetY, this.stafflineY - BUBBLE_STRIP);
    const rows = [top, Math.max(this.offsetY, top + BUBBLE_ROW)];
    const places = this.bubbleEls.map((el, i) => ({
      x: this.xOfOnset(this.score.harmony[i]!.onsetIndex),
      width: el.offsetWidth,
    }));
    bubbleRows(places).forEach((row, i) => {
      this.bubbleEls[i]!.style.top = `${rows[row]!}px`;
    });
  }

  /** Every chord the cursor has left behind reads dimmed; the CSS says how fast. */
  private dimBubbles(onsetIndex: number): void {
    this.bubbleEls.forEach((el, i) => {
      el.classList.toggle('past', this.score.harmony[i]!.onsetIndex < onsetIndex);
    });
  }

  /** Scales the content so the staff line fills the sheet block, and lifts the dead paper away. */
  private fit(): void {
    const scale = clamp(this.host.clientHeight / this.contentHeight, 0.42, 1.2);
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
    const step = this.walk[stepIndex];
    const onset = step ? this.score.onsets[step.onsetIndex] : undefined;
    return onset ? (this.score.measures[onset.measureIndex]?.number ?? 0) : 0;
  }

  /**
   * The pitch colour of a note, or the miss grey once it has been marked. A note of the inactive
   * hand is context only: it drops to the scaffolding tier and takes no mark.
   */
  private paintNote(note: Note, head = noteheadEl(this.osmd, note.source)): void {
    if (!head) return;
    const colour =
      isInactiveHand(this.hands, note.hand)
        ? tone(INK.scaffolding, this.dark)
        : this.misses.has(note.source)
          ? tone(INK.miss, this.dark)
          : colorOf(note.midi, 'muted', this.dark);
    paintHead(head, {
      fill: colour,
      stroke: colour,
      'stroke-width': null,
      'paint-order': null,
      opacity: null,
    });
  }
}

/**
 * Which row each bubble takes, reading left to right: the second row for one that would print over
 * the bubble before it. A third bubble over the same place shares the second row with the second.
 */
export function bubbleRows(bubbles: { x: number; width: number }[]): number[] {
  let filled = -Infinity;
  return bubbles.map(({ x, width }) => {
    if (x - width / 2 < filled) return 1;
    filled = x + width / 2 + BUBBLE_GAP;
    return 0;
  });
}

function child(parent: HTMLElement, style: string): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = style;
  parent.append(el);
  return el;
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
  // Nothing prints above the staff but the tempo mark, so the page margin is dead space.
  osmd.EngravingRules.PageTopMargin = 0;
  return osmd;
}
