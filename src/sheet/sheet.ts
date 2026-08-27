// The sheet of the play screen: one endless horizontal staff line, the pitch-class palette written
// straight onto the SVG, and the amber cursor band that rides over it. Everything here is DOM and
// OSMD; the clock lives in src/play/engine.ts and only arrives as a snapshot once a frame.

import { clamp } from '@/lib/utils';
import { CURSOR, INK, PAPER, colorOf, tone } from '@/look/color';
import { EASE, easeInOut, reducedMotion } from '@/look/motion';
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

/** Width of a Section handle, and how much of it stands past the bar edge it marks. */
const HANDLE_W = 5;
const HANDLE_PAST = 3;

/** Side of the square × that clears the Section, and its whole hit area. */
const CLEAR_SIZE = 18;

/** Clear paper kept above the highest ink of the sheet. */
const TOP_AIR = 4;

/** How far into a bubble row a label must reach to take it; less than this is slack in its box. */
const LABEL_REACH = 3;

/**
 * The ring drawn around the noteheads of the Onset the cursor stands at. It reads as paper
 * cleared out of the amber cursor band, so it works on either paper.
 */
const OUTLINE = '#ffffff';

/** A backward jump names its bar over the sheet for this long. */
const MARKER_MS = 800;

/** How long the jump marker takes to come up, of the time it stands. */
const MARKER_IN_MS = 120;

/** Pointer travel that turns a click into a Section drag, in screen pixels. */
const DRAG_SLOP = 4;

/** While Running a scroll detaches the view, and it snaps back this long after the last input. */
const DETACH_MS = 2000;

/** How long the view takes to glide back to the cursor once it attaches to it again. */
const SCROLL_GLIDE_MS = 300;

/** Part of the view at each edge that counts as off it: a seek landing there still moves the view. */
const EDGE = 0.1;

/** Width of the count-in runner, the line travelling to the standing cursor. */
const RUNNER_W = 2;

/** How long the cursor takes to slide when it is not being moved by the clock. */
const GLIDE_MS = 220;

/** How long the cursor band takes to grow or shrink into a new size, as the Section's tint fades. */
const EASE_MS = 200;

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

/** The left and right edge of something drawn on the paper, in unscaled pixels. */
interface Span {
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
  /** The count-in line, which runs to the standing cursor while the count-in lasts. */
  private readonly runner: HTMLElement;
  private readonly marker: HTMLElement;
  private readonly bubbles: HTMLElement;
  private bubbleEls: HTMLElement[] = [];
  /** The Section: one tinted band and a handle at each end, the end one carrying the ×. */
  private readonly tint: HTMLElement;
  private readonly handles: [HTMLElement, HTMLElement];
  private readonly clear: HTMLElement;
  /** Tint and handles together: they show, hide and move as one. */
  private readonly band: HTMLElement[];
  /** Takes every listener this sheet put on the host off again. */
  private readonly listeners = new AbortController();

  private section: Section | null = null;
  private drag: Drag | null = null;
  /** Wall-clock time of the last free scroll: the view snaps back two seconds after it. */
  private scrolledAt = -Infinity;
  /** The played timeline the cursor reads; the engine swaps it when Loop goes on. */
  private walk: PlayStep[] = [];
  /** Left and right edge of each bar in unscaled pixels, for the Section a drag picks. */
  private boxes: (Span | undefined)[] = [];

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
    jumpAt: -Infinity,
    jumpBar: 0,
    running: true,
    transition: '',
    glideUntil: -Infinity,
    /** Whether the view is following the cursor, as against the reader holding it. */
    attached: false,
    /** Whether a glide is still carrying the view to the cursor while the reader holds it. */
    chasing: false,
    /** Pixels the view stood away from the cursor when the glide began, and when that was. */
    scrollFrom: 0,
    scrollAt: -Infinity,
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
    // The paper under the tint stays reachable, so a fresh drag can start inside a Section.
    this.tint = child(overlay, 'position:absolute;pointer-events:none');
    this.handles = [
      child(overlay, `position:absolute;width:${HANDLE_W}px;cursor:ew-resize`),
      child(overlay, `position:absolute;width:${HANDLE_W}px;cursor:ew-resize`),
    ];
    this.band = [this.tint, ...this.handles];
    // The class carries the fade and the glide of the Section; src/index.css holds them.
    for (const el of this.band) el.className = 'sheet-section';
    this.clear = child(
      this.handles[1],
      `position:absolute;top:0;left:0;width:${CLEAR_SIZE}px;height:${CLEAR_SIZE}px;` +
        'border-radius:0 4px 4px 0;cursor:pointer',
    );
    // The cross itself is drawn by the class: two bars centred by CSS, not a glyph on a baseline.
    this.clear.className = 'sheet-section-clear';
    this.clear.setAttribute('role', 'button');
    this.clear.setAttribute('aria-label', 'Clear section');
    this.clear.title = 'Clear section';
    // No transition: the runner is written every frame, and a glide would lag the beat it marks.
    this.runner = child(overlay, `position:absolute;display:none;width:${RUNNER_W}px`);
    this.runner.className = 'sheet-runner';
    this.cursor = child(overlay, 'position:absolute;border-radius:12px');
    this.cursor.className = 'sheet-cursor';
    this.marker = child(
      overlay,
      'position:absolute;display:none;padding:1px 6px;border-radius:999px;' +
        'font-size:11px;font-weight:600;white-space:nowrap',
    );
    this.marker.className = 'sheet-marker';
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
   * What a click at a screen x means: the Onset nearest it, however far away, and the bar the
   * click fell in, which is the Onset before it or the next one past that bar's edge.
   */
  private hitAt(clientX: number): SheetHit | null {
    const x = this.contentX(clientX);
    const onsets = this.score.onsets;
    if (onsets.length === 0) return null;
    let i = 0;
    while (i + 1 < onsets.length && this.placed[i + 1]!.x <= x) i++;
    const next = i + 1 < onsets.length ? i + 1 : i;
    const near = Math.abs(this.placed[next]!.x - x) < Math.abs(this.placed[i]!.x - x) ? next : i;
    const bar = x > this.placed[i]!.measureRight ? next : i;
    return { seek: { onset: near }, measure: onsets[bar]!.measureIndex };
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

  /**
   * Puts the note states of a play back on every notehead: a note it names is skipped and reads in
   * the miss grey, every other note in its pitch colour. One entry per played note, in played
   * order, so a repeated bar takes the state of its last pass.
   */
  setMarks(notes: readonly { note: Note }[], missed: (index: number) => boolean): void {
    notes.forEach((note, index) => this.markNote(note.note, missed(index) ? 'miss' : 'none'));
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
    // A tie sounds as one note and only the note that starts it is ever struck, so its whole chain
    // takes the mark. Every member is the same pitch on the same staff, so one colour serves them.
    const tie = note.source.NoteTie;
    const chain = tie?.StartNote === note.source ? tie.Notes : [note.source];
    for (const member of chain) {
      if (kind === 'miss') this.misses.add(member);
      else this.misses.delete(member);
      this.paintNote(note, member === note.source ? head : noteheadEl(this.osmd, member));
    }
  }

  /**
   * One frame: the cursor to its interpolated x, the current Onset outlined, the jump marker while
   * it lasts, and the scroll that keeps the cursor about 30 % from the left edge.
   */
  frame(snap: Snapshot, windowTicks: number, now: number): void {
    this.fit();
    // A count-in stands the cursor where it leads, and sends the runner over the bars it counts.
    const counting = snap.state === 'counting-in';
    const at = this.cursorAt(
      counting ? snap.countInTo : snap.playedTick,
      snap.stepIndex,
      windowTicks,
    );
    this.drawRunner(counting ? snap : null, windowTicks);

    const running = snap.state === 'running' || snap.state === 'counting-in';
    if (running !== this.drawn.running) {
      this.drawn.running = running;
      // Play snaps the view to the cursor, whatever the reader scrolled to while it was still.
      this.scrolledAt = -Infinity;
    }
    // A step further off than the clock could walk to in one frame: a seek either way, or the loop
    // wrap that runs the cursor back over the sheet. A written repeat steps by one and snaps
    // instead, `cursorAt` having already run the cursor to the measure's right edge. However far
    // the jump, the CSS transition below carries it in the same GLIDE_MS.
    const jumped = Math.abs(at.stepIndex - this.drawn.step) > 1;
    if (running && jumped) this.drawn.glideUntil = now + GLIDE_MS;
    // The inline transition wins over any class, so it names every property the band eases. Its
    // size follows the matching window, the zoom and the system, all of which step now and then;
    // its x is written every frame while the clock walks the sheet, and only a jump glides it.
    // A band with no size yet would grow out of nothing, so it takes its first one flat.
    const motion = !reducedMotion() && this.cursor.style.width !== '';
    const glide = motion && (!running || now < this.drawn.glideUntil);
    const transition = motion
      ? `width ${EASE_MS}ms ${EASE},height ${EASE_MS}ms ${EASE},top ${EASE_MS}ms ${EASE}` +
        (glide ? `,transform ${GLIDE_MS}ms ${EASE}` : '')
      : 'none';
    if (transition !== this.drawn.transition) {
      this.drawn.transition = transition;
      this.cursor.style.transition = transition;
    }
    this.cursor.style.transform = `translateX(${at.x - at.width / 2}px)`;
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
    // scroll during one; the rest of the time it holds the cursor 30 % from the left edge. It
    // takes that hold back by gliding in from wherever the reader left it.
    const follow = at.x * this.drawn.scale - this.scroll.clientWidth * 0.3;
    const attached = running && now - this.scrolledAt >= DETACH_MS;
    const took = attached && !this.drawn.attached;
    this.drawn.attached = attached;
    // A jump carries the view with the band: always while the view follows the cursor, and while
    // the reader holds it only when the cursor would otherwise land off the paper they are reading.
    if (took || (jumped && (attached || this.offView(at)))) {
      this.drawn.scrollFrom = reducedMotion() ? 0 : this.scroll.scrollLeft - follow;
      this.drawn.scrollAt = now;
      this.drawn.chasing = true;
    }
    if (attached || this.drawn.chasing) {
      const done = easeInOut(clamp((now - this.drawn.scrollAt) / SCROLL_GLIDE_MS, 0, 1));
      this.scroll.scrollLeft = follow + this.drawn.scrollFrom * (1 - done);
      // A view that follows the cursor never stops; one the reader holds is theirs again at the end.
      this.drawn.chasing = !attached && done < 1;
    }
  }

  /** Whether the cursor stands off the view, counting a strip at each edge as off it. */
  private offView(at: CursorAt): boolean {
    const x = at.x * this.drawn.scale - this.scroll.scrollLeft;
    const width = this.scroll.clientWidth;
    return x < width * EDGE || x > width * (1 - EDGE);
  }

  /**
   * The count-in runner: a thin line travelling from where the count-in started to the cursor,
   * which stands still at the tick the count-in leads to. Off in every other state.
   */
  private drawRunner(snap: Snapshot | null, windowTicks: number): void {
    if (!snap) {
      if (this.runner.style.display !== 'none') this.runner.style.display = 'none';
      return;
    }
    this.runner.style.display = 'block';
    const x = this.runnerX(snap.playedTick, snap.stepIndex, windowTicks);
    this.runner.style.transform = `translateX(${x - RUNNER_W / 2}px)`;
    this.runner.style.top = `${this.system.top}px`;
    this.runner.style.height = `${this.system.bottom - this.system.top}px`;
  }

  /**
   * Where the runner stands for a played tick. A count-in into the first Onset runs at ticks the
   * walk has no place for, so it comes in from the left at the first step's own spacing.
   */
  private runnerX(playedTick: number, hint: number, windowTicks: number): number {
    const first = this.walk[0];
    if (!first || playedTick >= first.tick) return this.cursorAt(playedTick, hint, windowTicks).x;
    const from = this.placed[first.onsetIndex]?.x ?? 0;
    const next = this.walk[1];
    const to = next ? (this.placed[next.onsetIndex]?.x ?? from) : from;
    const span = next ? next.tick - first.tick : 0;
    const perTick = span > 0 ? Math.max(0, to - from) / span : 0;
    return Math.max(0, from - (first.tick - playedTick) * perTick);
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
    const section = this.section;
    const inside = !!section && hit.measure >= section.from && hit.measure <= section.to;
    // A press outside the Section's bars starts a fresh one there. On a handle, or inside the
    // Section, the far end stays put and the drag moves the near one.
    const held = section && (end !== 'pick' || inside);
    const anchor = held ? (end === 'from' ? section.to : section.from) : hit.measure;
    this.drag = { end, anchor, hit, x: event.clientX, moved: end !== 'pick' };
    try {
      (event.target as Element).setPointerCapture?.(event.pointerId);
    } catch {
      // A pointer already gone by the time this runs cannot be captured, and without the capture
      // the drag only stops at the host's edge instead of following the pointer past it.
    }
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
    const show = !!(section && from && to);
    // A hidden band keeps its last geometry, which is what it fades out from.
    if (!show) {
      for (const el of this.band) el.classList.remove('on');
      return;
    }
    const unplaced = this.tint.style.left === '';
    const top = this.system.top;
    const height = this.system.bottom - top;
    const ink = tone(INK.duration, this.dark);
    this.tint.style.left = `${from.left}px`;
    this.tint.style.top = `${top}px`;
    this.tint.style.width = `${to.right - from.left}px`;
    this.tint.style.height = `${height}px`;
    this.tint.style.background = `color-mix(in srgb, ${ink} 9%, transparent)`;
    for (const [i, handle] of this.handles.entries()) {
      handle.style.left = `${(i === 0 ? from.left : to.right) - (HANDLE_W - HANDLE_PAST)}px`;
      handle.style.top = `${top}px`;
      handle.style.height = `${height}px`;
      handle.style.background = ink;
    }
    // The × is a tab on the outside of the end handle, at its top, in the same ink: one border
    // with a rounded knob to its right.
    this.clear.style.background = ink;
    this.clear.style.color = tone(PAPER, this.dark);
    // A band that has never stood anywhere takes its first place flat, before `.on` puts it on the
    // paper: with the transition live it would glide in from the edge it hangs at unplaced.
    if (unplaced) {
      for (const el of this.band) {
        el.style.transition = 'none';
        void el.offsetWidth;
        el.style.transition = '';
      }
    }
    for (const el of this.band) el.classList.add('on');
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
    // stops short of the sheet's highest ink, so a slur over the top staff survives it as a
    // label does.
    const svg = this.paper.querySelector('svg') as SVGSVGElement | null;
    const inkTop = svg ? svg.getBBox().y : this.stafflineY;
    this.offsetY = Math.max(0, Math.min(this.stafflineY - BUBBLE_STRIP, inkTop - TOP_AIR));
    this.contentHeight = bottom - this.offsetY + 8;
    this.contentWidth = Number(this.paper.querySelector('svg')?.getAttribute('width')) || 1200;

    this.placeBubbles();
    this.drawSection();

    // The band's inner edge is a border rather than an inset shadow: a border is part of the box
    // the compositor hands the band, so nothing of it can print outside the layer that moves.
    this.cursor.style.background = `color-mix(in srgb, ${tone(CURSOR, this.dark)} 26%, transparent)`;
    this.cursor.style.border = `1px solid color-mix(in srgb, ${tone(CURSOR, this.dark)} 55%, transparent)`;
    this.runner.style.background = `color-mix(in srgb, ${tone(CURSOR, this.dark)} 55%, transparent)`;
    this.marker.style.background = tone(INK.duration, this.dark);
    this.marker.style.color = tone(PAPER, this.dark);
  }

  /**
   * One bubble per chord event of the Score, standing over its Onset in the strip of paper above
   * the top staff. A bubble that would print over the one before it drops to a second row rather
   * than sliding away from its Onset; one that would print over an OSMD label moves right of the
   * label. Widths are measured unscaled, as the x values are, so the rows hold at every scale.
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
    const blocked = rows.map((y) => this.labelSpans(y, y + BUBBLE_ROW));
    bubblePlaces(places, blocked).forEach((at, i) => {
      this.bubbleEls[i]!.style.left = `${at.x}px`;
      this.bubbleEls[i]!.style.top = `${rows[at.row]!}px`;
    });
  }

  /**
   * Left and right edge of every label OSMD printed into one row of the strip: the tempo mark, the
   * tempo word, a dynamic above the staff, a bar number. Labels are sorted by their left edge.
   */
  private labelSpans(top: number, bottom: number): Span[] {
    const spans: Span[] = [];
    for (const label of this.paper.querySelectorAll('svg text, svg .vf-stavetempo')) {
      const box = (label as SVGGraphicsElement).getBBox();
      if (Math.min(box.y + box.height, bottom) - Math.max(box.y, top) > LABEL_REACH) {
        spans.push({ left: box.x, right: box.x + box.width });
      }
    }
    return spans.sort((a, b) => a.left - b.left);
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
    // Up over MARKER_IN_MS and down over the whole stand, both on the shared curve; the lower of
    // the two ramps holds at every moment, so the label neither snaps on nor lingers.
    const fade = Math.min(
      easeInOut(clamp(age / MARKER_IN_MS, 0, 1)),
      1 - easeInOut(clamp(age / MARKER_MS, 0, 1)),
    );
    this.marker.style.opacity = String(fade);
    this.marker.style.transform = `translateX(${at.x - 20}px)`;
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
 * Where each bubble prints, reading left to right: the row it takes and the x it centres on. A
 * bubble that would print over the bubble before it or over a label of its row takes the row that
 * leaves it nearest its Onset; when both rows are taken it moves right of what stands there.
 */
export function bubblePlaces(
  bubbles: { x: number; width: number }[],
  blocked: Span[][],
): { x: number; row: number }[] {
  const filled = blocked.map(() => -Infinity);
  return bubbles.map(({ x, width }) => {
    const xs = blocked.map((spans, row) => clearOf(x, width, filled[row]!, spans));
    const row = xs[0]! <= xs[1]! ? 0 : 1;
    filled[row] = xs[row]! + width / 2 + BUBBLE_GAP;
    return { x: xs[row]!, row };
  });
}

/** The leftmost centre at or right of `x` clear of the row's last bubble and of its labels. */
function clearOf(x: number, width: number, filled: number, spans: Span[]): number {
  let at = Math.max(x, filled + width / 2);
  for (const span of spans) {
    if (at - width / 2 < span.right && at + width / 2 > span.left) {
      at = span.right + BUBBLE_GAP + width / 2;
    }
  }
  return at;
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
  return osmd;
}
