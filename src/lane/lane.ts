// The falling lane and the keyboard under it, on one 2D canvas so both share the x axis. Time in
// the lane is played time, the clock the engine keeps: a repeated passage falls again as new notes
// behind a dashed divider. Everything here is drawing; the play itself lives in src/play/engine.ts.

import { KEYBOARD_H, drawKeyboard, keyLayout, keyRange, type KeyLayout } from '@/lane/keyboard';
import { INK, PAPER, colorOf, tone } from '@/look/color';
import { reducedMotion } from '@/look/motion';
import type { Engine, PlayEvent, Snapshot } from '@/play/engine';
import type { HandsSetting } from '@/play/settings';
import { TICKS_PER_QUARTER, type Hand } from '@/score/types';

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
const TOP_BAR = 48;

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
  beatTicks: number;
  endTick: number;
}

/** A backward jump: the divider that falls with the notes and crosses the now-line at the jump. */
interface LaneJump {
  tick: number;
  label: string;
}

export class Lane {
  /** Live look knobs: the gear writes into this object and the next frame reads it. */
  readonly look: LaneLook;
  /** Shown over the keys while the app has no MIDI input. */
  notice: string | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly engine: Engine;
  private readonly bars: LaneBar[];
  private readonly jumps: LaneJump[];
  private readonly range: [number, number];
  private layout: KeyLayout;
  private dark: boolean;
  private effects: Effect[] = [];
  private now = 0;
  private playedTick = 0;
  /** The hands setting the blocks are drawn for, the one before it, and when it changed. */
  private hands: HandsSetting;
  private handsBefore: HandsSetting;
  private handsAt = -Infinity;

  constructor(canvas: HTMLCanvasElement, engine: Engine, look: LaneLook, dark: boolean) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.engine = engine;
    this.look = look;
    this.dark = dark;
    this.bars = barsOf(engine);
    this.jumps = jumpsOf(engine);
    this.hands = engine.settings.hands;
    this.handsBefore = this.hands;
    // The range spans both hands, so a change of hands never re-lays the keyboard out.
    this.range = keyRange(engine.notes, engine.settings);
    this.layout = keyLayout(this.range[0], this.range[1], canvas.clientWidth || 1);
  }

  setDark(dark: boolean): void {
    this.dark = dark;
  }

  /** Feedback at the key: a ring for a hit or an extra, a red blink for a miss. */
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
    const ctx = this.ctx;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
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
    const reference = Math.max((window.innerHeight - TOP_BAR) * (1 - DEFAULT_SPLIT) - KEYBOARD_H, 120);
    const pxPerTick = reference / Math.max(this.look.lookaheadBeats, 1) / TICKS_PER_QUARTER;

    ctx.fillStyle = tone(PAPER, this.dark);
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, laneH);
    ctx.clip();
    this.drawGrid(width, laneH, pxPerTick);
    this.drawJumps(width, laneH, pxPerTick);
    this.drawNotes(laneH, pxPerTick);
    ctx.restore();

    this.drawNowLine(width, laneH, windowTicks * pxPerTick);
    this.drawRings(laneH);
    drawKeyboard(ctx, this.layout, laneH, this.dark, this.look.keyLabels, this.keyFill);
    if (this.notice) this.drawNotice(width, laneH);
  }

  /** Lane y of a played tick: the now-line is the foot of the lane and time falls towards it. */
  private y(tick: number, laneH: number, pxPerTick: number): number {
    return laneH - (tick - this.playedTick) * pxPerTick;
  }

  private drawGrid(width: number, laneH: number, pxPerTick: number): void {
    const ctx = this.ctx;
    const top = this.playedTick + laneH / pxPerTick;
    ctx.font = '11px ui-monospace, monospace';
    ctx.lineWidth = 1;
    for (const bar of this.bars) {
      if (bar.endTick < this.playedTick) continue;
      if (bar.tick > top) break;
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

  private drawJumps(width: number, laneH: number, pxPerTick: number): void {
    const ctx = this.ctx;
    const top = this.playedTick + laneH / pxPerTick;
    ctx.font = '13px system-ui, sans-serif';
    for (const jump of this.jumps) {
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

  private drawNotes(laneH: number, pxPerTick: number): void {
    const ctx = this.ctx;
    const engine = this.engine;
    const top = this.playedTick + laneH / pxPerTick;
    const fade = Math.min(1, (this.now - this.handsAt) / HANDS_FADE_MS);
    for (let i = 0; i < engine.notes.length; i++) {
      const note = engine.notes[i]!;
      if (note.tick > top) break;
      const bottom = this.y(note.tick, laneH, pxPerTick);
      if (bottom < -10) continue;
      const key = this.layout.byMidi.get(note.midi);
      if (!key) continue;

      const y = this.y(note.tick + note.durationTicks, laneH, pxPerTick);
      if (y > laneH) continue;
      const width = key.w * (this.look.noteWidthPct / 100);
      const x = key.x + (key.w - width) / 2;
      const height = Math.max(bottom - y - this.look.gapPx, 3);
      const radius = Math.min(NOTE_RADIUS, width / 3, height / 3);
      // How much of a ghost the note is now: a change of hands cross-fades it over the two looks.
      const ghost = isGhost(this.hands, note.hand)
        ? fade
        : isGhost(this.handsBefore, note.hand)
          ? 1 - fade
          : 0;

      ctx.save();
      if (ghost < 1) {
        const state = engine.noteState(i);
        const age = this.now - engine.resolvedAt(i);
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

  /** The now-line, with a band over it as tall in time as the matching window at play tempo. */
  private drawNowLine(width: number, laneH: number, bandH: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = this.dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)';
    ctx.fillRect(0, laneH - bandH, width, bandH);
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
   * that is still sounding. A miss blinks red; every other held key is grey.
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

  private drawNotice(width: number, laneH: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = this.dark ? 'rgba(22,22,22,0.82)' : 'rgba(233,233,233,0.82)';
    ctx.fillRect(0, laneH, width, KEYBOARD_H);
    ctx.fillStyle = tone(LANE_LABEL, this.dark);
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(this.notice!, width / 2, laneH + KEYBOARD_H / 2 + 4);
    ctx.textAlign = 'left';
  }
}

/** A note of the hand the play does not expect. */
function isGhost(hands: HandsSetting, hand: Hand): boolean {
  return hands !== 'both' && hands !== hand;
}

// Dash patterns as constants, because setLineDash takes a fresh array otherwise on every frame.
const DASH = [7, 5];
const SOLID: number[] = [];

/** Every bar of the play in played time, one entry per pass of a repeated bar. */
function barsOf(engine: Engine): LaneBar[] {
  const { score } = engine;
  const bars: LaneBar[] = [];
  for (const step of score.playOrder) {
    const onset = score.onsets[step.onsetIndex];
    const measure = onset ? score.measures[onset.measureIndex] : undefined;
    if (!onset || !measure) continue;
    const tick = step.tick - (onset.tick - measure.startTick);
    if (bars.length > 0 && bars[bars.length - 1]!.tick === tick) continue;
    bars.push({
      tick,
      number: measure.number,
      beatTicks: (TICKS_PER_QUARTER * 4) / measure.beatUnit,
      endTick: tick + measure.durationTicks,
    });
  }
  return bars;
}

/** Where the play order goes back in the sheet, which is where a divider falls. */
function jumpsOf(engine: Engine): LaneJump[] {
  const { score } = engine;
  const jumps: LaneJump[] = [];
  for (let i = 1; i < score.playOrder.length; i++) {
    const from = score.onsets[score.playOrder[i - 1]!.onsetIndex];
    const to = score.onsets[score.playOrder[i]!.onsetIndex];
    if (!from || !to || to.tick >= from.tick) continue;
    const number = score.measures[to.measureIndex]?.number ?? to.measureIndex + 1;
    jumps.push({ tick: score.playOrder[i]!.tick, label: `↺ back to bar ${number}` });
  }
  return jumps;
}
