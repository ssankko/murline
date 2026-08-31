// The Preview's sheet: the whole piece as one endless vertical flow of systems, fitted to the
// width of its host, with the cursor band the Preview's clock walks down the page. No MIDI input
// and no marks on played notes: the reader clicks where to hear from, and the band follows.

import { clamp } from '@/lib/utils';
import { CURSOR, INK, colorOf, tone } from '@/look/color';
import { EASE, easeInOut, reducedMotion } from '@/look/motion';
import type { SeekTarget } from '@/play/engine';
import { DEFAULT_PLAY_SETTINGS } from '@/play/settings';
import { buildScore } from '@/score/build';
import { analyzeHarmony } from '@/score/harmony';
import { loadInto } from '@/score/load';
import { TICKS_PER_QUARTER, bpmAt, type Note, type Score } from '@/score/types';
import { applyTheme, noteheadEl, paintHead } from './paint';
import { SpacingPinch, type Pinch } from './pinch';
import { bandWidth, hitAt, place, systemsOf } from './place';
import {
  BUBBLE_ROW,
  BUBBLE_STRIP,
  DEFAULT_SPACING,
  DETACH_MS,
  GLIDE_MS,
  SCROLL_GLIDE_MS,
  SheetPaper,
  bubblePlaces,
  child,
  labelBoxes,
  labelSpans,
  makeBubble,
  type SheetLook,
} from './sheet';

/** Host width that reads at zoom 1. A wider window grows the notation instead of the bar count. */
const BASE_WIDTH = 1000;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 1.5;

/** Width change small enough that a re-render would show nothing new. */
const SETTLED = 8;

/** The band's system is kept inside this share of the view from its top while the piece plays. */
const KEEP = 2 / 3;

/** Where the band's system is carried to once it leaves that share: its top this far down the view. */
const REST = 1 / 4;

/** Notation size for a host of this width. */
function zoomFor(width: number): number {
  return clamp(width / BASE_WIDTH, MIN_ZOOM, MAX_ZOOM);
}

/** One system's place on the paper, in pixels: its whole height and its top staff line. */
interface SystemBox {
  top: number;
  bottom: number;
  staffline: number;
}

/** Where the band stands, in pixels of the paper. */
interface BandAt {
  x: number;
  /** Width of the band: the matching window, drawn at the sheet's own spacing. */
  width: number;
  onsetIndex: number;
  stepIndex: number;
  system: number;
}

/** One loaded Preview sheet: its OSMD instance, the Score behind it and the DOM it draws into. */
export class PreviewSheet extends SheetPaper {
  /** A click on the paper: the screen decides what a seek does. */
  seekTo: ((target: SeekTarget) => void) | null = null;
  /** A pinch has settled on a spacing: the screen stores it. */
  spacedTo: ((spacing: number) => void) | null = null;
  /** Every step of a live pinch, and `null` once it is over: the screen shows what it is choosing. */
  pinching: ((pinch: Pinch | null) => void) | null = null;
  /**
   * The matching window in played ticks, which the band takes its width from. Opens at the global
   * window at the piece's written tempo; the screen writes it again as the tempo changes.
   */
  windowTicks = 0;

  /** OSMD's own clear paper between one system's lowest ink and the next system's highest. */
  private readonly systemAir: number;
  private readonly host: HTMLElement;
  /** The one element of the host this sheet owns: `dispose` takes it and everything in it away. */
  private readonly content: HTMLElement;
  /** The nearest ancestor that scrolls the page, which the follow moves; null when none does. */
  private readonly scroller: HTMLElement | null;
  private readonly pinch: SpacingPinch;

  private drawnWidth = 0;
  private systems: SystemBox[] = [];
  /** Wall-clock time of the last hand scroll: the follow stays off for two seconds after it. */
  private scrolledAt = -Infinity;
  /** The scroll position the follow last wrote: a scroll event landing elsewhere is the reader's. */
  private wroteScroll = -1;
  private drawn = {
    /** The played tick of the last frame: a re-render puts the band back from it. */
    tick: 0,
    onset: -1,
    step: -1,
    system: -1,
    playing: false,
    transition: '',
    glideUntil: -Infinity,
    /** The scroll glide under way: from where to where, and when it began. */
    scroll: null as { from: number; to: number; at: number } | null,
  };

  private constructor(host: HTMLElement, dark: boolean) {
    const content = child(host, 'position:relative');
    super(content, dark, {
      backend: 'svg',
      autoResize: false,
      // One page of unbounded height: the systems wrap down the window and never break to a page.
      pageFormat: 'Endless',
      drawCredits: true,
      // Without the part name every system's staff starts at the page margin.
      drawPartNames: false,
    });
    this.host = host;
    this.content = content;
    this.cursor = child(this.overlay, 'position:absolute;border-radius:12px');
    this.cursor.className = 'sheet-cursor';
    this.systemAir = this.osmd.EngravingRules.MinSkyBottomDistBetweenSystems;

    const { signal } = this.listeners;
    this.content.addEventListener('click', (event) => this.clicked(event), { signal });
    this.scroller = scrollParentOf(host);
    // A wheel with ctrl held is a pinch, which the pinch below takes; any other input that moves
    // the page away from where the follow put it is the reader's, and holds the view for a while.
    this.scroller?.addEventListener(
      'wheel',
      (event) => {
        if (!event.ctrlKey) this.scrolledAt = performance.now();
      },
      { passive: true, signal },
    );
    this.scroller?.addEventListener(
      'scroll',
      () => {
        if (Math.abs(this.scroller!.scrollTop - this.wroteScroll) > 1) {
          this.scrolledAt = performance.now();
        }
      },
      { signal },
    );
    this.pinch = new SpacingPinch(host, {
      spacing: () => this.spacing,
      active: () => this.proportional,
      moving: (pinch) => this.pinching?.(pinch),
      onSettle: (spacing) => {
        this.spacing = spacing;
        this.reflow();
        this.spacedTo?.(spacing);
      },
    });
  }

  /** Loads the bytes, draws them at the host's width and builds the Score of what was drawn. */
  static async open(
    host: HTMLElement,
    bytes: Uint8Array,
    fileName: string,
    dark: boolean,
    proportional = false,
    spacing = DEFAULT_SPACING,
  ): Promise<PreviewSheet> {
    const sheet = new PreviewSheet(host, dark);
    sheet.spacing = spacing;
    await loadInto(sheet.osmd, bytes, fileName);
    sheet.render();
    sheet.score = buildScore(sheet.osmd.Sheet);
    sheet.score.harmony = analyzeHarmony(sheet.score);
    // The engraving stands here, and it is the only render that says what a measure's notes pack
    // into; every render after it carries the width factors of a spacing.
    sheet.engraved = sheet.osmd.GraphicSheet.MeasureList.map(
      (staves) => staves.find((measure) => measure)?.minimumStaffEntriesWidth ?? 0,
    );
    sheet.windowTicks = windowTicksOf(sheet.score);
    sheet.proportional = proportional;
    if (proportional) sheet.render();
    sheet.layout();
    return sheet;
  }

  /** Re-fits the sheet to the host, which a resize has made wider or narrower. */
  fit(): void {
    if (Math.abs(this.host.clientWidth - this.drawnWidth) < SETTLED) return;
    this.reflow();
  }

  /** Repaints the whole sheet for the other theme. */
  setDark(dark: boolean): void {
    this.dark = dark;
    applyTheme(this.osmd, dark);
    this.reflow();
  }

  /**
   * Turns the chord bubbles and the pitch colouring on and off. The strip takes room between the
   * systems only while it is on, so the harmony switch draws the page again.
   */
  setLook(look: Partial<SheetLook>): void {
    const was = { ...this.look };
    Object.assign(this.look, look);
    if (this.look.harmony !== was.harmony) this.reflow();
    else if (this.look.colour !== was.colour) this.repaint();
  }

  /**
   * One frame: the band to the played tick, the Onset it stands on outlined, and the page scrolled
   * to keep the band's system in view while the piece plays.
   */
  frame(playedTick: number, playing: boolean, now: number): void {
    this.drawn.tick = playedTick;
    const at = this.cursorAt(playedTick);
    this.drawBand(at, playing, now);
    this.follow(at.system, playing, now);
  }

  /** Takes only this sheet's own DOM out of the host, which may already hold the next one. */
  dispose(): void {
    this.listeners.abort();
    this.pinch.dispose();
    this.osmd.clear();
    this.content.remove();
  }

  /** Renders at the host's width and reads everything the render moved. */
  protected override reflow(): void {
    this.render();
    this.layout();
  }

  /** Writes the zoom, the spacing and the room for the strip, then renders. */
  private render(): void {
    this.drawnWidth = this.host.clientWidth;
    this.osmd.zoom = zoomFor(this.drawnWidth);
    const rules = this.osmd.EngravingRules;
    // The strip is a fixed height of paper above each top staff line, so it asks for more units at
    // a smaller zoom.
    rules.MinSkyBottomDistBetweenSystems =
      this.systemAir + (this.look.harmony ? BUBBLE_STRIP / (10 * this.osmd.zoom) : 0);
    this.space();
    this.osmd.render();
  }

  /** Pixel geometry, pitch colours, bubbles and the band: everything a fresh render wipes. */
  private layout(): void {
    const unit = 10 * this.osmd.zoom;
    this.systems = systemsOf(this.osmd).map((system) => {
      const box = system.PositionAndShape;
      return {
        top: (box.AbsolutePosition.y + box.BorderTop) * unit,
        bottom: (box.AbsolutePosition.y + box.BorderBottom) * unit,
        staffline: (system.StaffLines[0]?.PositionAndShape.AbsolutePosition.y ?? 0) * unit,
      };
    });
    this.placement = place(this.osmd, this.score, this.proportional);
    this.repaint();
    this.placeBubbles();
    // The band's inner edge is a border rather than an inset shadow: a border is part of the box
    // the compositor hands the band, so nothing of it can print outside the layer that moves.
    const ink = tone(CURSOR, this.dark);
    this.cursor.style.background = `color-mix(in srgb, ${ink} 26%, transparent)`;
    this.cursor.style.border = `1px solid color-mix(in srgb, ${ink} 55%, transparent)`;
    // Every system moved, so the band takes its place again flat, wherever the clock last stood.
    this.drawn.onset = -1;
    this.drawn.system = -1;
    this.drawBand(this.cursorAt(this.drawn.tick), false, performance.now());
  }

  /**
   * Where the band stands for a played tick: between the Onset the tick falls in and the next one
   * on the same system, or run to the bar's right edge when the next stands on another system or
   * earlier on the page. Before the first Onset it stands on the first Onset.
   */
  private cursorAt(playedTick: number): BandAt {
    const order = this.score.playOrder;
    let i = clamp(this.drawn.step, 0, order.length - 1);
    while (i + 1 < order.length && order[i + 1]!.tick <= playedTick) i++;
    while (i > 0 && order[i]!.tick > playedTick) i--;

    const step = order[i];
    const next = order[i + 1];
    const { placed, pxPerTick } = this.placement;
    const here = placed[step?.onsetIndex ?? 0] ?? { x: 0, measureRight: 0, system: 0 };
    const there = next ? placed[next.onsetIndex] : undefined;
    const back =
      !!step &&
      !!next &&
      this.score.onsets[next.onsetIndex]!.tick < this.score.onsets[step.onsetIndex]!.tick;
    const snap = !there || back || there.system !== here.system;
    const toX = snap ? Math.max(here.measureRight, here.x) : there.x;
    const span = next && step ? next.tick - step.tick : 0;
    const done = span > 0 ? clamp((playedTick - step!.tick) / span, 0, 1) : 0;
    // The gap to the next Onset over the ticks it covers, which the band's width falls back to
    // while the sheet is spaced by its engraving.
    const local = span > 0 ? Math.abs(toX - here.x) / span : 0;
    return {
      x: here.x + (toX - here.x) * done,
      width: bandWidth(this.windowTicks, pxPerTick || local),
      onsetIndex: step?.onsetIndex ?? 0,
      stepIndex: i,
      system: here.system,
    };
  }

  /**
   * Writes the band. Its x glides on a seek within a system and whenever the clock is still; it
   * is written flat while the clock walks it, and always when it changes system.
   */
  private drawBand(at: BandAt, playing: boolean, now: number): void {
    const { drawn } = this;
    const jumped = Math.abs(at.stepIndex - drawn.step) > 1;
    if (playing && jumped) drawn.glideUntil = now + GLIDE_MS;
    // A band with no size yet would grow out of nothing, so it takes its first place flat.
    const motion = !reducedMotion() && this.cursor.style.width !== '' && at.system === drawn.system;
    const glide = motion && (!playing || now < drawn.glideUntil);
    const transition = glide ? `transform ${GLIDE_MS}ms ${EASE}` : 'none';
    if (transition !== drawn.transition) {
      drawn.transition = transition;
      this.cursor.style.transition = transition;
    }
    const box = this.systems[at.system] ?? { top: 0, bottom: 0 };
    this.cursor.style.transform = `translateX(${at.x - at.width / 2}px)`;
    this.cursor.style.width = `${at.width}px`;
    this.cursor.style.top = `${box.top}px`;
    this.cursor.style.height = `${box.bottom - box.top}px`;
    drawn.step = at.stepIndex;
    drawn.system = at.system;

    if (at.onsetIndex !== drawn.onset) {
      this.outline(this.outlined, false);
      this.outlined = this.score.onsets[at.onsetIndex]?.notes ?? [];
      this.outline(this.outlined, true);
      this.dimBubbles(at.onsetIndex);
      drawn.onset = at.onsetIndex;
    }
  }

  /**
   * Keeps the band's system inside the upper part of the view while the piece plays: once it
   * leaves, the page glides until the system's top stands a quarter of the way down. Paused, or
   * for two seconds after a hand scroll, the page is the reader's.
   */
  private follow(system: number, playing: boolean, now: number): void {
    const scroller = this.scroller;
    if (!scroller) return;
    if (playing !== this.drawn.playing) {
      this.drawn.playing = playing;
      // Play takes the view to the band, wherever the reader scrolled to while it was still.
      this.scrolledAt = -Infinity;
    }
    const box = this.systems[system];
    if (!playing || !box || now - this.scrolledAt < DETACH_MS) {
      this.drawn.scroll = null;
      return;
    }
    if (!this.drawn.scroll) {
      const origin =
        this.content.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      const top = origin + box.top;
      const view = scroller.clientHeight;
      const from = scroller.scrollTop;
      if (top >= from && origin + box.bottom <= from + view * KEEP) return;
      this.drawn.scroll = { from, to: Math.max(0, top - view * REST), at: now };
    }
    const { from, to, at } = this.drawn.scroll;
    const done = reducedMotion() ? 1 : easeInOut(clamp((now - at) / SCROLL_GLIDE_MS, 0, 1));
    scroller.scrollTop = from + (to - from) * done;
    this.wroteScroll = scroller.scrollTop;
    if (done >= 1) this.drawn.scroll = null;
  }

  /** A click seeks to the moment nearest it on the system it fell in. */
  private clicked(event: MouseEvent): void {
    const rect = this.content.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const hit = hitAt(x, this.score.onsets, this.placement, this.systemAt(y));
    if (hit) this.seekTo?.(hit.seek);
  }

  /** The system a y of the paper falls in, or the nearest one when it falls between two. */
  private systemAt(y: number): number {
    let best = 0;
    let distance = Infinity;
    this.systems.forEach((box, i) => {
      const away = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
      if (away < distance) {
        distance = away;
        best = i;
      }
    });
    return best;
  }

  /**
   * One bubble per chord event, standing over its Onset in the strip above its system's top staff.
   * Each system's strip fills its two rows on its own, the same way as the play sheet's one strip.
   */
  private placeBubbles(): void {
    this.bubbles.replaceChildren();
    this.bubbleEls = [];
    if (!this.look.harmony) return;
    const { harmony } = this.score;
    this.bubbleEls = harmony.map((event) => makeBubble(this.bubbles, event, this.dark));
    const labels = labelBoxes(this.paper);
    // The bubbles of each system, read off the placement in one pass; a chord OSMD never placed
    // lands on no system and is left where it hangs.
    const perSystem: number[][] = this.systems.map(() => []);
    harmony.forEach((event, i) => {
      perSystem[this.placement.placed[event.onsetIndex]?.system ?? -1]?.push(i);
    });
    this.systems.forEach((box, system) => {
      const top = box.staffline - BUBBLE_STRIP;
      const rows = [top, top + BUBBLE_ROW];
      const blocked = rows.map((y) => labelSpans(labels, y, y + BUBBLE_ROW));
      const mine = perSystem[system]!;
      const places = mine.map((i) => ({
        x: this.xOfOnset(harmony[i]!.onsetIndex),
        width: this.bubbleEls[i]!.offsetWidth,
      }));
      bubblePlaces(places, blocked).forEach((at, k) => {
        const el = this.bubbleEls[mine[k]!]!;
        el.style.left = `${at.x}px`;
        el.style.top = `${rows[at.row]!}px`;
      });
    });
  }

  /** Writes every notehead's colour again, and the ring of the Onset the band stands on. */
  private repaint(): void {
    for (const onset of this.score.onsets) {
      for (const note of onset.notes) {
        const head = noteheadEl(this.osmd, note.source);
        if (!head) continue;
        const colour = this.colourOf(note);
        paintHead(head, { fill: colour, stroke: colour, 'stroke-width': null, 'paint-order': null });
      }
    }
    this.outline(this.outlined, true);
  }

  /** A note's pitch colour, or the plain ink of every other glyph while the colouring is off. */
  protected override colourOf(note: Note): string {
    return this.look.colour ? colorOf(note.midi, 'muted', this.dark) : tone(INK.duration, this.dark);
  }
}

/**
 * The global matching window in played ticks, at the piece's written tempo taken `percent` fast.
 * A faster clock covers more ticks in the same milliseconds, so the band grows with the tempo.
 */
export function windowTicksOf(score: Score, percent = 100): number {
  const bpm = score.hasTempo ? bpmAt(score, 0) : 120;
  const ticksPerMs = (bpm * (percent / 100) * TICKS_PER_QUARTER) / 60_000;
  return DEFAULT_PLAY_SETTINGS.matchingWindowMs * ticksPerMs;
}

/** The nearest ancestor that scrolls, which is the page the Preview screen puts the host in. */
function scrollParentOf(host: HTMLElement): HTMLElement | null {
  for (let el = host.parentElement; el; el = el.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(el).overflowY)) return el;
  }
  return null;
}
