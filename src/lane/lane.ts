// The falling lane and the keyboard under it, on one 2D canvas so both share the x axis. Time in
// the lane is played time, the clock the engine keeps: a repeated passage falls again as new notes
// behind a dashed divider. Everything here is drawing; the play itself lives in src/play/engine.ts.

import { KEYBOARD_H, drawKeyboard, keyLayout, keyRange, type KeyLayout } from '@/lane/keyboard';
import { clamp } from '@/lib/utils';
import { INK, PAPER, colorOf, tone } from '@/look/color';
import { reducedMotion } from '@/look/motion';
import type { Engine, LoopSpan, PlayEvent, Snapshot } from '@/play/engine';
import type { Section } from '@/play/section';
import { isInactiveHand, type HandsSetting } from '@/play/settings';
import { barsOfWalk, beatOf } from '@/score/beat';
import { TICKS_PER_QUARTER, type ChordEvent, type PlayStep, type Score } from '@/score/types';

/** Look knobs, all global settings the gear writes to. */
export interface LaneLook {
  lookaheadBeats: number;
  /** Width of a block as a percent of its key. */
  noteWidthPct: number;
  gapPx: number;
  keyLabels: boolean;
}

export const DEFAULT_LANE_LOOK: LaneLook = {
  lookaheadBeats: 8,
  noteWidthPct: 80,
  gapPx: 2,
  keyLabels: true,
};

/** Share of the window height the sheet takes by default; the beat scale is fixed against it. */
export const DEFAULT_SPLIT = 0.35;
export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.6;

/** Height of the top bar, which is not part of the split. */
export const TOP_BAR = 48;

const LANE_LINE = ['#e3e3e3', '#2c2c2c'] as const;
const LANE_BAR = ['#c8c8c8', '#464646'] as const;
const LANE_LABEL = ['#6e6e6e', '#8f8f8f'] as const;
const NOW_LINE = ['#141414', '#ffffff'] as const;

/** A key held on nothing, and the ring an extra leaves. Neither is a pitch, so neither is coloured. */
const GREY = '#8b8b93';

const NOTE_RADIUS = 3;
const HIT_FLASH_MS = 200;
const MISS_FLASH_MS = 300;
const RING_MS = 300;
/** The inactive hand is context: its notes fall as ghosts and never take feedback. */
const GHOST_ALPHA = 0.25;
/** How long a change of hands takes to cross-fade the blocks it turns into ghosts, and back. */
const HANDS_FADE_MS = 200;

/** The Section's tint, and how long it takes to come up or go, as on the sheet. */
const SECTION_ALPHA = 0.09;
const SECTION_FADE_MS = 200;

/** The harmony panel at the lane's top right: its inset from the corner, the gap between rows. */
const PANEL_INSET = 16;
const PANEL_GAP = 4;
/** How long the panels take to move up a slot when the harmony advances. */
const PANEL_SLIDE_MS = 250;
/** Side padding a name keeps inside its panel; a name that needs more is set smaller. */
const PANEL_PAD = 6;
/** The chrome tone a panel over the lane wears: paper enough to read on, sheer enough to see past. */
const PANEL_FILL = ['rgba(233,233,233,0.82)', 'rgba(22,22,22,0.82)'] as const;
/** The panel of the chord sounding now, and of each of the two after it: its size and its type. */
const CHORD_PANEL = { w: 128, h: 64, weight: 700, size: 26 };
const NEXT_PANEL = { w: 72, h: 36, weight: 600, size: 15 };
/** A beat glyph: its width, a capsule's height, the step to the next one, the gap to the panel. */
const GLYPH_W = 4;
const GLYPH_TALL = 8;
const GLYPH_STEP = 6;
const GLYPH_GAP = 8;
/** How far the countdown counts; a chord further off than this holds a full row until it nears. */
const LOOKAHEAD = 16;

/** One ring or blink playing out at a key. */
interface Effect {
  kind: 'hit' | 'extra' | 'miss';
  midi: number;
  start: number;
}

/** A bar line in played time, with the beat grid inside it. */
interface LaneBar {
  tick: number;
  number: number;
  measure: number;
  beatTicks: number;
  endTick: number;
}

/** A backward jump: the divider that falls with the notes and crosses the now-line at the jump. */
interface LaneJump {
  tick: number;
  label: string;
}

/** A chord of the harmony in played time: a repeated bar names its chords again. */
export interface LaneChord {
  tick: number;
  event: ChordEvent;
}

/** Where one panel stands and the type its name takes: a slot of the panel, or a step between two. */
export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  weight: number;
}

/** One beat of a countdown: the tick it ends at, how long it lasts, and whether it opens a bar. */
export interface BeatGlyph {
  end: number;
  span: number;
  strong: boolean;
}

export class Lane {
  /** Live look knobs: the gear writes into this object and the next frame reads it. */
  readonly look: LaneLook;
  /** Shown over the keys while the app has no MIDI input. */
  notice: string | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly engine: Engine;
  private readonly resize: ResizeObserver;
  private bars: LaneBar[];
  private jumps: LaneJump[];
  private chords: LaneChord[];
  /** The walk the bars and the dividers were read from; Loop swaps it for the linear one. */
  private walk: PlayStep[];
  private range: [number, number];
  private layout: KeyLayout;
  private dark: boolean;
  private effects: Effect[] = [];
  private now = 0;
  private playedTick = 0;
  /** The hands setting the blocks are drawn for, the one before it, and when it changed. */
  private hands: HandsSetting;
  private handsBefore: HandsSetting;
  private handsAt = -Infinity;
  /**
   * The Section the band is drawn for, which a clear leaves in place while it fades out, whether
   * there is one now, and when that last changed.
   */
  private shownSection: Section | null = null;
  private sectionOn = false;
  private sectionAt = -Infinity;
  /**
   * What the harmony panel drew last frame: the chord in the top slot, the chord under it, when the
   * panels last moved up a slot, and the chord leaving the top slot while it fades out.
   */
  private shownCurrent: LaneChord | null = null;
  private shownNext: LaneChord | null = null;
  private changeAt = -Infinity;
  private leaving: LaneChord | null = null;
  /**
   * Canvas size and window height, taken only when they change. The sheet writes its own styles
   * every frame, so reading them here would make the browser lay the page out again each time.
   */
  private size = { width: 0, height: 0, windowHeight: 0 };

  constructor(canvas: HTMLCanvasElement, engine: Engine, look: LaneLook, dark: boolean) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.engine = engine;
    this.look = look;
    this.dark = dark;
    this.walk = engine.walk;
    this.bars = barsOf(engine.score, this.walk);
    this.jumps = jumpsOf(engine.score, this.walk);
    this.chords = chordsOf(engine.score.harmony, this.walk);
    this.hands = engine.settings.hands;
    this.handsBefore = this.hands;
    // The range spans both hands, so a change of hands never re-lays the keyboard out.
    this.range = keyRange(engine.notes, engine.settings);
    this.measure();
    this.layout = keyLayout(this.range[0], this.range[1], this.size.width || 1);
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(canvas);
  }

  /** Stops watching the canvas, which is what a screen leaving the lane behind must call. */
  dispose(): void {
    this.resize.disconnect();
  }

  private measure(): void {
    this.size = {
      width: this.canvas.clientWidth,
      height: this.canvas.clientHeight,
      windowHeight: window.innerHeight,
    };
  }

  setDark(dark: boolean): void {
    this.dark = dark;
  }

  /** Lays the keyboard out again after the keyboard range setting changed. */
  setRange(): void {
    this.range = keyRange(this.engine.notes, this.engine.settings);
    this.layout = keyLayout(this.range[0], this.range[1], this.size.width || 1);
  }

  /** Feedback at the key: a ring for a hit or an extra, a grey blink for a miss. */
  effect(event: PlayEvent, now: number): void {
    if (event.verdict === 'absorbed') return;
    this.effects.push({ kind: event.verdict, midi: event.midi, start: now });
  }

  /** One frame. Nothing is kept between frames but the effects still playing out. */
  frame(snap: Snapshot, windowTicks: number, now: number): void {
    this.now = now;
    this.playedTick = snap.playedTick;
    if (this.engine.settings.hands !== this.hands) {
      this.handsBefore = this.hands;
      this.hands = this.engine.settings.hands;
      this.handsAt = reducedMotion() ? -Infinity : now;
    }
    const section = this.engine.section;
    if (section) this.shownSection = section;
    if (this.sectionOn !== (section !== null)) {
      this.sectionOn = section !== null;
      this.sectionAt = reducedMotion() ? -Infinity : now;
    }
    const ctx = this.ctx;
    const { width, height } = this.size;
    if (width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * dpr)) this.canvas.width = Math.round(width * dpr);
    if (this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.height = Math.round(height * dpr);
    }
    if (this.layout.width !== width) {
      this.layout = keyLayout(this.range[0], this.range[1], width);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    while (this.effects.length > 0 && now - this.effects[0]!.start > RING_MS) this.effects.shift();

    const laneH = Math.max(height - KEYBOARD_H, 40);
    // Pixels per beat come from the window, not from the lane, so dragging the split shows more or
    // fewer beats and never stretches a note.
    const reference = Math.max(
      (this.size.windowHeight - TOP_BAR) * (1 - DEFAULT_SPLIT) - KEYBOARD_H,
      120,
    );
    const pxPerTick = reference / Math.max(this.look.lookaheadBeats, 1) / TICKS_PER_QUARTER;

    ctx.fillStyle = tone(PAPER, this.dark);
    ctx.fillRect(0, 0, width, height);

    if (this.engine.walk !== this.walk) {
      this.walk = this.engine.walk;
      this.bars = barsOf(this.engine.score, this.walk);
      this.jumps = jumpsOf(this.engine.score, this.walk);
      this.chords = chordsOf(this.engine.score.harmony, this.walk);
    }

    const loop = this.engine.loopSpan();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, laneH);
    ctx.clip();
    this.drawGrid(width, laneH, pxPerTick, -Infinity, loop?.to ?? Infinity);
    this.drawSection(width, laneH, pxPerTick);
    this.drawCountIn(width, laneH, pxPerTick, this.engine.countInBeats);
    this.drawNotes(laneH, pxPerTick, -Infinity, loop?.to ?? Infinity, true);
    if (loop) this.drawNextLap(width, laneH, pxPerTick, loop);
    this.drawJumps(width, laneH, pxPerTick, loop);
    this.drawHarmony(width, loop);
    ctx.restore();

    this.drawNowLine(width, laneH, windowTicks * 2 * pxPerTick);
    this.drawRings(laneH);
    drawKeyboard(ctx, this.layout, laneH, this.dark, this.look.keyLabels, this.keyFill);
    if (this.notice) this.drawNotice(width, laneH);
  }

  /** Lane y of a played tick: the now-line is the foot of the lane and time falls towards it. */
  private y(tick: number, laneH: number, pxPerTick: number): number {
    return laneH - (tick - this.playedTick) * pxPerTick;
  }

  private drawGrid(
    width: number,
    laneH: number,
    pxPerTick: number,
    floor: number,
    ceiling: number,
  ): void {
    const ctx = this.ctx;
    const top = Math.min(this.playedTick + laneH / pxPerTick, ceiling);
    ctx.font = '11px ui-monospace, monospace';
    ctx.lineWidth = 1;
    for (const bar of this.bars) {
      if (bar.endTick < this.playedTick || bar.tick < floor) continue;
      if (bar.tick >= top) break;
      for (let tick = bar.tick; tick < bar.endTick - 1e-9; tick += bar.beatTicks) {
        const y = Math.round(this.y(tick, laneH, pxPerTick)) + 0.5;
        if (y < -20 || y > laneH + 20) continue;
        ctx.strokeStyle = tone(tick === bar.tick ? LANE_BAR : LANE_LINE, this.dark);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        if (tick === bar.tick) {
          ctx.fillStyle = tone(LANE_LABEL, this.dark);
          ctx.fillText(`bar ${bar.number}`, 6, y - 5);
        }
      }
    }
  }

  /** The count-in: one line per beat left, falling to the now-line where the music starts. */
  private drawCountIn(width: number, laneH: number, pxPerTick: number, beats: number[]): void {
    if (beats.length === 0) return;
    const ctx = this.ctx;
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.strokeStyle = tone(NOW_LINE, this.dark);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1;
    for (let i = 0; i < beats.length; i++) {
      const y = Math.round(this.y(beats[i]!, laneH, pxPerTick)) + 0.5;
      if (y < -20 || y > laneH) continue;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.fillText(String(beats.length - i), 10, y - 6);
    }
  }

  /**
   * The lap above the divider: the same bars again, one lap higher. Nothing of it carries feedback,
   * because none of it has been played yet.
   */
  private drawNextLap(width: number, laneH: number, pxPerTick: number, loop: LoopSpan): void {
    // Drawing the lap one lap lower than the clock puts it one lap higher in the lane.
    const played = this.playedTick;
    this.playedTick -= loop.to - loop.from;
    this.drawGrid(width, laneH, pxPerTick, loop.from, loop.to);
    this.drawNotes(laneH, pxPerTick, loop.from, loop.to, false);
    this.playedTick = played;
  }

  /** The Section as a tinted band over its bars, whether or not Loop gives it force. */
  private drawSection(width: number, laneH: number, pxPerTick: number): void {
    const section = this.shownSection;
    if (!section) return;
    const eased = Math.min(1, (this.now - this.sectionAt) / SECTION_FADE_MS);
    const alpha = SECTION_ALPHA * (this.sectionOn ? eased : 1 - eased);
    if (alpha <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = tone(INK.duration, this.dark);
    for (const bar of this.bars) {
      if (bar.measure < section.from || bar.measure > section.to) continue;
      const top = Math.round(this.y(bar.endTick, laneH, pxPerTick));
      const bottom = Math.round(this.y(bar.tick, laneH, pxPerTick));
      if (bottom < 0 || top > laneH) continue;
      ctx.fillRect(0, top, width, bottom - top);
    }
    ctx.restore();
  }

  /** The wrap divider: the lap goes back to the bar the Section opens at. */
  private wrapDivider(loop: LoopSpan): LaneJump {
    const bar = this.bars.find((each) => each.tick <= loop.from && loop.from < each.endTick);
    return { tick: loop.to, label: backToBar(bar?.number ?? 1) };
  }

  private drawJumps(width: number, laneH: number, pxPerTick: number, loop: LoopSpan | null): void {
    const ctx = this.ctx;
    const top = this.playedTick + laneH / pxPerTick;
    ctx.font = '13px system-ui, sans-serif';
    // A looping Section walks its bars linearly, so the wrap is the only divider. Loop over the
    // whole piece keeps the written repeats, so their dividers fall as well as the wrap.
    const jumps = loop
      ? this.engine.section
        ? [this.wrapDivider(loop)]
        : [...this.jumps, this.wrapDivider(loop)]
      : this.jumps;
    for (const jump of jumps) {
      if (jump.tick > top) break;
      const y = this.y(jump.tick, laneH, pxPerTick);
      if (y > laneH + 40) continue;
      ctx.strokeStyle = tone(NOW_LINE, this.dark);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = 2;
      ctx.setLineDash(DASH);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
      ctx.setLineDash(SOLID);
      ctx.fillText(jump.label, 10, y - 6);
    }
  }

  private drawNotes(
    laneH: number,
    pxPerTick: number,
    floor: number,
    ceiling: number,
    live: boolean,
  ): void {
    const ctx = this.ctx;
    const engine = this.engine;
    const top = Math.min(this.playedTick + laneH / pxPerTick, ceiling);
    const fade = Math.min(1, (this.now - this.handsAt) / HANDS_FADE_MS);
    for (let i = 0; i < engine.notes.length; i++) {
      const note = engine.notes[i]!;
      if (note.tick >= top) break;
      // The note that starts a tie carries the whole chain, so its continuations fall as nothing.
      if (note.tick < floor || !note.strikeable) continue;
      const bottom = this.y(note.tick, laneH, pxPerTick);
      if (bottom < -10) continue;
      const key = this.layout.byMidi.get(note.midi);
      if (!key) continue;

      // A note hanging over the wrap is cut at the bar line the lap ends on.
      const y = this.y(Math.min(note.tick + note.durationTicks, ceiling), laneH, pxPerTick);
      if (y > laneH) continue;
      const width = key.w * (this.look.noteWidthPct / 100);
      const x = key.x + (key.w - width) / 2;
      const height = Math.max(bottom - y - this.look.gapPx, 3);
      const radius = Math.min(NOTE_RADIUS, width / 3, height / 3);
      // How much of a ghost the note is now: a change of hands cross-fades it over the two looks.
      const ghost = isInactiveHand(this.hands, note.hand)
        ? fade
        : isInactiveHand(this.handsBefore, note.hand)
          ? 1 - fade
          : 0;

      ctx.save();
      if (ghost < 1) {
        const state = live ? engine.noteState(i) : 'pending';
        const age = live ? this.now - engine.resolvedAt(i) : Infinity;
        let fill = colorOf(note.midi, 'muted', this.dark);
        let glow = 0;
        if (state === 'miss') fill = tone(INK.miss, this.dark);
        else if (state === 'hit' && age < HIT_FLASH_MS) {
          fill = '#ffffff';
          glow = 14 * (1 - age / HIT_FLASH_MS);
        }

        ctx.globalAlpha = 1 - ghost;
        if (glow > 0) {
          ctx.shadowColor = colorOf(note.midi, 'muted', this.dark);
          ctx.shadowBlur = glow;
        }
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.roundRect(x, y, width, height, radius);
        ctx.fill();
        ctx.shadowBlur = 0;

        // The left hand carries a dark border and a dot, the right hand a thin light one, so the
        // hand a block belongs to reads without colour.
        if (note.hand === 'left') {
          ctx.strokeStyle = 'rgba(0,0,0,0.65)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(x + 1, y + 1, width - 2, height - 2, Math.max(radius - 1, 1));
          ctx.stroke();
          if (height > 10 && width > 8) {
            ctx.fillStyle = 'rgba(0,0,0,0.65)';
            ctx.beginPath();
            ctx.arc(x + width / 2, y + 5, 2, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(x + 0.5, y + 0.5, width - 1, height - 1, radius);
          ctx.stroke();
        }
      }

      // A ghost is rhythm alone: the lane's ink, no pitch colour, no hand border, no dot.
      if (ghost > 0) {
        ctx.globalAlpha = GHOST_ALPHA * ghost;
        ctx.fillStyle = tone(INK.duration, this.dark);
        ctx.beginPath();
        ctx.roundRect(x, y, width, height, radius);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /**
   * The now-line, inside a band as tall in time as the matching window: early on one side of the
   * line, late on the other. The keyboard is drawn over the late half.
   */
  private drawNowLine(width: number, laneH: number, bandH: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = this.dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(0, laneH - bandH / 2, width, bandH);
    ctx.strokeStyle = tone(NOW_LINE, this.dark);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, laneH - 0.75);
    ctx.lineTo(width, laneH - 0.75);
    ctx.stroke();
  }

  /** A hit sends a ring in its own colour up from the key top; an extra a small grey one. */
  private drawRings(laneH: number): void {
    const ctx = this.ctx;
    for (const effect of this.effects) {
      if (effect.kind === 'miss') continue;
      const key = this.layout.byMidi.get(effect.midi);
      if (!key) continue;
      const age = (this.now - effect.start) / RING_MS;
      if (age > 1) continue;
      const hit = effect.kind === 'hit';
      ctx.strokeStyle = hit ? colorOf(effect.midi, 'muted', this.dark) : GREY;
      ctx.globalAlpha = 1 - age;
      ctx.lineWidth = hit ? 3 : 1.5;
      ctx.beginPath();
      ctx.arc(key.x + key.w / 2, laneH, (hit ? 30 : 14) * age + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /**
   * The key colour rule: a held key wears its pitch colour only while its strike matched a note
   * that is still sounding. A miss blinks the miss grey; every other held key is grey.
   */
  private readonly keyFill = (midi: number, base: string): string => {
    const state = this.engine.keyState(midi);
    if (state === 'color') return colorOf(midi, 'muted', this.dark);
    if (state === 'grey') return GREY;
    for (const effect of this.effects) {
      if (effect.kind === 'miss' && effect.midi === midi && this.now - effect.start < MISS_FLASH_MS) {
        return tone(INK.miss, this.dark);
      }
    }
    return base;
  };

  /**
   * The chord sounding now and the two after it, each on its own panel at the top right. A next
   * chord counts the beats left before it left of its panel: one glyph per beat, a capsule where a
   * bar opens and a dot inside it, the leftmost the beat that ends first. When the harmony advances
   * to the chord that stood next, every panel slides up one slot and the one on top leaves.
   */
  private drawHarmony(width: number, loop: LoopSpan | null): void {
    if (this.chords.length === 0) return;
    // Past the wrap the panel reads the lap again, as the lane draws it again.
    const chords = loop
      ? throughWrap(this.chords, loop, (chord, by) => ({ ...chord, tick: chord.tick + by }))
      : this.chords;
    const bars = loop
      ? throughWrap(this.bars, loop, (bar, by) => ({
          ...bar,
          tick: bar.tick + by,
          endTick: bar.endTick + by,
        }))
      : this.bars;

    const [current, ...next] = chordsAt(chords, this.playedTick);
    // Only the natural advance slides: the chord that was next has become the chord in force. A
    // seek, a Loop toggle or the first chord of all snaps the panels into their slots.
    if (current?.tick !== this.shownCurrent?.tick) {
      const advanced =
        current !== undefined &&
        this.shownCurrent !== null &&
        current.tick === this.shownNext?.tick;
      this.changeAt = advanced && !reducedMotion() ? this.now : -Infinity;
      this.leaving = advanced ? this.shownCurrent : null;
      this.shownCurrent = current ?? null;
    }
    this.shownNext = next[0] ?? null;

    const rows: { chord: LaneChord; slot: number; glyphs: BeatGlyph[] }[] = [];
    if (current) rows.push({ chord: current, slot: 0, glyphs: [] });
    next.forEach((chord, i) => {
      if (!chord) return;
      rows.push({ chord, slot: i + 1, glyphs: beatsBefore(bars, this.playedTick, chord.tick) });
    });

    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Every panel comes from the slot below the one it takes, the newest from under the lot.
    const t = Math.min(1, (this.now - this.changeAt) / PANEL_SLIDE_MS);
    const eased = easeOutBack(t);
    const step = (slot: number) =>
      t === 1
        ? slotRect(slot, width)
        : lerpRect(slotRect(slot + 1, width), slotRect(slot, width), eased);
    if (t < 1 && this.leaving) {
      this.drawRow(step(-1), this.leaving, [], 1 - t);
    }
    for (const row of rows) {
      this.drawRow(step(row.slot), row.chord, row.glyphs, row.slot === 2 ? t : 1);
    }
    // The rest of the lane draws on the defaults.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /** One panel where the step it is at puts it, its name inside and its countdown left of it. */
  private drawRow(rect: PanelRect, chord: LaneChord, glyphs: BeatGlyph[], alpha: number): void {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = tone(PANEL_FILL, this.dark);
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 4);
    ctx.fill();

    // A name too long for its panel steps down through smaller type until it fits.
    let size = rect.size;
    ctx.font = `${rect.weight} ${size}px system-ui, sans-serif`;
    while (size > 10 && ctx.measureText(chord.event.absolute).width > rect.w - PANEL_PAD * 2) {
      size -= 2;
      ctx.font = `${rect.weight} ${size}px system-ui, sans-serif`;
    }
    ctx.fillStyle = tone(INK.duration, this.dark);
    ctx.fillText(chord.event.absolute, rect.x + rect.w / 2, rect.y + rect.h / 2);

    // The countdown stands outside the panel, its last glyph against the panel's left edge, so
    // the beats still to come hold their place as the row shrinks toward the panel.
    const bottom = rect.y + rect.h / 2 + 2;
    const fading = !reducedMotion();
    ctx.fillStyle = tone(INK.scaffolding, this.dark);
    glyphs.forEach((glyph, i) => {
      // A glyph fades over the last quarter of its beat, off the clock alone.
      const remains = (glyph.end - this.playedTick) / (glyph.span / 4);
      ctx.globalAlpha = alpha * (fading ? clamp(remains, 0, 1) : 1);
      const x = rect.x - GLYPH_GAP - GLYPH_W - (glyphs.length - 1 - i) * GLYPH_STEP;
      ctx.beginPath();
      if (glyph.strong) ctx.roundRect(x, bottom - GLYPH_TALL, GLYPH_W, GLYPH_TALL, GLYPH_W / 2);
      else ctx.arc(x + GLYPH_W / 2, bottom - GLYPH_W / 2, GLYPH_W / 2, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  private drawNotice(width: number, laneH: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = tone(PANEL_FILL, this.dark);
    ctx.fillRect(0, laneH, width, KEYBOARD_H);
    ctx.fillStyle = tone(LANE_LABEL, this.dark);
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(this.notice!, width / 2, laneH + KEYBOARD_H / 2 + 4);
    ctx.textAlign = 'left';
  }
}

/** What every divider says, wrap and written repeat alike. */
const backToBar = (number: number) => `↺ back to bar ${number}`;

// Dash patterns as constants, because setLineDash takes a fresh array otherwise on every frame.
const DASH = [7, 5];
const SOLID: number[] = [];

/** Every bar of the play in played time, one entry per pass of a repeated bar. */
function barsOf(score: Score, walk: PlayStep[]): LaneBar[] {
  return barsOfWalk(score, walk).map(({ measure, tick }) => ({
    tick,
    number: measure.number,
    measure: measure.index,
    beatTicks: beatOf(measure).ticks,
    endTick: tick + measure.durationTicks,
  }));
}

/** Where the walk goes back in the sheet, which is where a divider falls. */
function jumpsOf(score: Score, walk: PlayStep[]): LaneJump[] {
  const jumps: LaneJump[] = [];
  for (let i = 1; i < walk.length; i++) {
    const from = score.onsets[walk[i - 1]!.onsetIndex];
    const to = score.onsets[walk[i]!.onsetIndex];
    if (!from || !to || to.tick >= from.tick) continue;
    const number = score.measures[to.measureIndex]?.number ?? to.measureIndex + 1;
    jumps.push({ tick: walk[i]!.tick, label: backToBar(number) });
  }
  return jumps;
}

/** Every chord of the harmony in played time, one entry per pass of a repeated bar. */
export function chordsOf(harmony: ChordEvent[], walk: PlayStep[]): LaneChord[] {
  const byOnset = new Map(harmony.map((event) => [event.onsetIndex, event]));
  const chords: LaneChord[] = [];
  for (const step of walk) {
    const event = byOnset.get(step.onsetIndex);
    if (event) chords.push({ tick: step.tick, event });
  }
  return chords;
}

/** The chord in force at a played tick and the two after it; the first is missing before them all. */
export function chordsAt(chords: LaneChord[], playedTick: number): (LaneChord | undefined)[] {
  const at = chords.findLastIndex((chord) => chord.tick <= playedTick);
  return [chords[at], chords[at + 1], chords[at + 2]];
}

/**
 * One glyph per beat left before a chord: a stick where a bar opens, a dot inside it, the beat
 * ending first at the head. A beat counts while it has not ended and it ends at or before the chord.
 */
export function beatsBefore(bars: LaneBar[], playedTick: number, chordTick: number): BeatGlyph[] {
  const glyphs: BeatGlyph[] = [];
  for (const bar of bars) {
    if (bar.endTick <= playedTick) continue;
    if (bar.tick >= chordTick) break;
    for (let tick = bar.tick; tick < bar.endTick - 1e-9; tick += bar.beatTicks) {
      const end = tick + bar.beatTicks;
      if (end <= playedTick || end > chordTick) continue;
      glyphs.push({ end, span: bar.beatTicks, strong: tick === bar.tick });
      if (glyphs.length === LOOKAHEAD) return glyphs;
    }
  }
  return glyphs;
}

/** A list in played time cut at the wrap, with the lap's own entries again one lap later. */
export function throughWrap<T extends { tick: number }>(
  items: T[],
  loop: LoopSpan,
  later: (item: T, by: number) => T,
): T[] {
  const lap = loop.to - loop.from;
  return [
    ...items.filter((item) => item.tick < loop.to),
    ...items
      .filter((item) => item.tick >= loop.from && item.tick < loop.to)
      .map((item) => later(item, lap)),
  ];
}

/**
 * Where a panel stands in slot `slot`: the chord in force takes slot 0, the two after it slots 1
 * and 2. Slot -1 is where a panel leaves and slot 3 where one comes from, both off the panel.
 */
export function slotRect(slot: number, width: number): PanelRect {
  const panel = slot === 0 ? CHORD_PANEL : NEXT_PANEL;
  const small = NEXT_PANEL.h + PANEL_GAP;
  // Over slot 0 the slots stack upward in the small panel's height, under it below the big one.
  const down = slot <= 0 ? slot * small : CHORD_PANEL.h + PANEL_GAP + (slot - 1) * small;
  return { x: width - PANEL_INSET - panel.w, y: PANEL_INSET + down, ...panel };
}

/** A panel part way from one slot to another; its weight changes over at the midpoint. */
export function lerpRect(from: PanelRect, to: PanelRect, t: number): PanelRect {
  const at = (a: number, b: number) => a + (b - a) * t;
  return {
    x: at(from.x, to.x),
    y: at(from.y, to.y),
    w: at(from.w, to.w),
    h: at(from.h, to.h),
    size: at(from.size, to.size),
    weight: t < 0.5 ? from.weight : to.weight,
  };
}

/** Fast out with a small overshoot, so a panel settles into its slot with a bounce. */
function easeOutBack(t: number): number {
  return 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
}
