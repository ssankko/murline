// The falling lane and the keyboard under it, on one 2D canvas so both share the x axis. Time in
// the lane is played time, the clock the engine keeps: a repeated passage falls again as new notes
// behind a dashed divider. The lane draws from `view`, the tick at the keyboard line, which rides
// the clock until a seek or the wheel takes it off and a glide brings it back, so the notes always
// roll to a new place instead of jumping there. Everything here is drawing; the play itself lives
// in src/play/engine.ts.

import {
  KEYBOARD_H,
  drawKeyboard,
  keyLayout,
  keyRange,
  type Key,
  type KeyLayout,
} from '@/lane/keyboard';
import { clamp } from '@/lib/utils';
import {
  INK,
  NOTE_NAMES,
  PAPER,
  colorOf,
  labelInk,
  mix,
  pitchClass,
  tone,
  type Palette,
} from '@/look/color';
import { easeInOut, reducedMotion } from '@/look/motion';
import type { Engine, LoopSpan, PlayEvent, SeekTarget, Snapshot } from '@/play/engine';
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
  /** Whether the harmony panels are drawn. */
  harmony: boolean;
  /** Whether a block wears the pitch colour of its note, against one neutral ink for every note. */
  colour: boolean;
  /** Whether a block carries the name of its note, sharps and no octave, at its landing edge. */
  names: boolean;
}

export const DEFAULT_LANE_LOOK: LaneLook = {
  lookaheadBeats: 8,
  noteWidthPct: 80,
  gapPx: 2,
  keyLabels: true,
  harmony: true,
  colour: true,
  names: false,
};

/** The span the gear offers for the lookahead, which a pinch zoom stays inside. */
const LOOK_MIN = 1;
const LOOK_MAX = 32;
/** Beats per unit of pinch delta: a full spread, about 140 of delta, halves the beats in view. */
const ZOOM_RATE = 0.005;
/** How long after a WebKit gesture event a ctrl-wheel is that same pinch, reported twice. */
const GESTURE_MS = 100;
/** How long a zoom stands still before the lane reports its lookahead to be written down. */
const LOOK_SETTLE_MS = 300;

/** WebKit's pinch, which the DOM types do not carry. */
interface GestureEvent extends UIEvent {
  readonly scale: number;
}

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

/**
 * How long the view takes to roll back onto the clock after a seek or a scroll, and the now-line
 * to cross to a tick that was clicked.
 */
export const GLIDE_MS = 300;
/** While the play runs the wheel detaches the view, and it rolls back this long after the last one. */
const DETACH_MS = 2000;
/** How long a count-in line takes to fade out once its beat is spent. */
const COUNT_FADE_MS = 120;
/**
 * The breath the count-in number takes as its beat is struck: how far it swells, how long the whole
 * breath runs, and the share of that it spends growing.
 */
const COUNT_POP = 0.45;
const COUNT_POP_MS = 260;
const COUNT_POP_RISE = 0.3;
/** How long the notice over the keys takes to come up or go. */
const NOTICE_FADE_MS = 150;

/** A key held on nothing, and the ring an extra leaves. Neither is a pitch, so neither is coloured. */
const GREY = '#8b8b93';

const NOTE_RADIUS = 3;
/** The name on a block: its font, the tab height a short block grows, and the room it wants each side. */
const NAME_FONT = '600 11px system-ui, sans-serif';
const NAME_MIN_H = 16;
const NAME_PAD = 4;
/** How long a struck block takes to fade from white back to its pitch colour. */
const HIT_FLASH_MS = 350;
const RING_MS = 300;
/** The inactive hand is context: its notes fall as ghosts and never take feedback. */
const GHOST_ALPHA = 0.25;
/** How long a change of hands takes to cross-fade the blocks it turns into ghosts, and back. */
const HANDS_FADE_MS = 200;

/** The Section's tint, and how long it takes to come up or go, as on the sheet. */
const SECTION_ALPHA = 0.09;
const SECTION_FADE_MS = 200;

/** How long the keys and the blocks over them take to travel to a new keyboard range. */
const RANGE_MS = 200;

/**
 * The glow a strike throws off its key top: how long it lives, and the radius and the peak alpha
 * it reaches between the softest strike and the hardest.
 */
const SPLASH_MS = 250;
const SPLASH_RADIUS = [16, 40] as const;
const SPLASH_ALPHA = [0.35, 0.8] as const;

/** How far a struck block swells at the peak of its pulse, and how long the whole pulse runs. */
const POP = 0.16;
const POP_MS = 140;

/**
 * A missed block: how long it takes to go grey, how far it sinks and how much of its alpha it
 * gives up on the way, and the sparks it grinds off the keyboard as it crosses.
 */
const MISS_MS = 300;
const MISS_SINK = 4;
const MISS_DIM = 0.3;
const GRIND_PER_S = 25;
const GRIND_SPREAD = Math.PI / 3;
const GRIND_GRAVITY = 300;

/**
 * The beat pulse at the now-line: the share of a beat it decays over, and what a full pulse adds to
 * the line's width and to the band's alpha. The beat a bar opens with gets twice the lift.
 */
const PULSE_SHARE = 0.12;
const PULSE_WIDTH = 0.75;
const PULSE_BAND = 0.06;

/**
 * How far a sounding key's face drains toward its base, over what share of the note's written
 * duration it gets there, and how long its release blink lasts.
 */
const DRAIN_FLOOR = 0.4;
const DRAIN_RUSH = 7.5;
const BLINK_MS = 120;

/** How long a key takes to sink under a finger and to come back up, both through the overshoot. */
const PRESS_MS = 120;
const RELEASE_MS = 160;

/**
 * Specks: how many a strike throws between the softest and the hardest, how wide each source aims,
 * how many a sounding key gives per second, how many the lane keeps, and the pull on a burst.
 */
const BURST = [6, 14] as const;
const BURST_SPREAD = Math.PI / 6;
const TRICKLE_SPREAD = (Math.PI * 5) / 12;
const TRICKLE_PER_S = 12;
/** How far a trickle speck wanders sideways and how fast it turns, in px/s and rad/s. */
const TRICKLE_DRIFT = 25;
const TRICKLE_TURN = 12;
const SPECK_CAP = 400;
const SPECK_GRAVITY = 200;
/** The longest step the specks take, so a frame the app slept through does not fling them away. */
const MAX_STEP_MS = 100;

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
/**
 * A countdown glyph burning up on its beat: the share of the beat the whole burn takes, the share
 * of the burn the collapse at the end takes, and how far the glyph swells before it goes.
 */
const BURN_SHARE = 0.25;
const BURN_COLLAPSE = 0.18;
const BURN_SWELL = 0.3;

/** One ring or splash playing out at a key. A miss leaves no mark on the keys. */
interface Effect {
  kind: 'hit' | 'extra';
  midi: number;
  start: number;
  /** How hard the key was struck, 1 to 127; 0 when no strike stands behind it. */
  velocity: number;
  /** Ticks the matched note still had to fall when the key went down: positive is early. */
  dTick: number;
}

/** One speck of a pitch colour rising off a key top. */
interface Speck {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Downward pull in px/s²: a burst arcs back, a trickle rises against none. */
  gravity: number;
  /** Sideways wander in px/s, which only a trickle takes; its own birth is its phase. */
  wobble: number;
  radius: number;
  born: number;
  life: number;
  alpha: number;
  color: string;
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
  /** Where a click in the lane asks the play to go; the screen decides what a seek means. */
  onSeek: ((target: SeekTarget) => void) | null = null;
  /** Where the lane says a pinch has changed its look, once the pinch has stood still. */
  onLook: ((look: Partial<LaneLook>) => void) | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly engine: Engine;
  private readonly resize: ResizeObserver;
  /** Takes the wheel and click listeners off the canvas again. */
  private readonly listeners = new AbortController();
  private bars: LaneBar[];
  private jumps: LaneJump[];
  private chords: LaneChord[];
  /** The walk the bars and the dividers were read from; Loop swaps it for the linear one. */
  private walk: PlayStep[];
  private range: [number, number];
  /** The layout of the range in force, the one the keys travel from, and when they set off. */
  private layout: KeyLayout;
  private layoutFrom: KeyLayout | null = null;
  private layoutAt = -Infinity;
  /** The layout every key and block is drawn on: part way between the two while they travel. */
  private shownLayout: KeyLayout;
  private dark: boolean;
  private effects: Effect[] = [];
  private particles: Speck[] = [];
  /** Specks the sounding keys have earned but not yet been given, as a fraction of one each. */
  private owed = 0;
  /** The same for a grinding miss, with this frame's whole share of it. */
  private groundOwed = 0;
  private groundDue = 0;
  /** When each key last went down or came up, which is what the press eases from. */
  private readonly presses = new Map<number, { down: boolean; at: number }>();
  /** When each key last began its release blink. */
  private readonly blinks = new Map<number, number>();
  private now = 0;
  private playedTick = 0;
  /** The tick at the keyboard line, which every y in the lane is measured from. */
  private view = 0;
  /** How far the view stands off the clock: 0 while it rides it. */
  private offset = 0;
  /** The offset the glide runs from and the wall time it began; `-Infinity` while none runs. */
  private glideFrom = 0;
  private glideAt = -Infinity;
  /** Wall time of the last wheel or click, which the detach window is measured from. */
  private scrolledAt = -Infinity;
  /** Wall time of the last WebKit gesture event, and the scale it carried; 0 between pinches. */
  private gestureAt = -Infinity;
  private pinchScale = 0;
  /** The timer that reports a zoom that has stood still. */
  private lookTimer = 0;
  /** The scale and the lane height of the last frame, which turn a wheel or a click into ticks. */
  private pxPerTick = 0;
  private laneH = 0;
  /** Set by a click that seeks: its jump goes into the offset and no glide takes the view back. */
  private holdView = false;
  /**
   * How far the now-line stands behind the clock in ticks, which a click seek opens and a glide of
   * its own closes, with the lag that glide runs from and the wall it began at.
   */
  private lineLag = 0;
  private lineFrom = 0;
  private lineAt = -Infinity;
  /**
   * Count-in lines as last drawn, keyed by their beat, kept past the beat while they fade out.
   * `spentAt` is the wall the clock crossed the beat, which its number pops from.
   */
  private readonly countLines = new Map<number, { y: number; label: string; spentAt: number }>();
  /** What the engine's counters and its motion read last frame, which is how a seek is spotted. */
  private lastResets: number;
  private lastWraps: number;
  private lastRunning = false;
  /** The clock and the wall of the frame before this one, which is what a step is measured over. */
  private before = 0;
  private beforeTick = 0;
  /** The wall of the frame before this one, which is what "settled since the last frame" reads. */
  private sinceWall = 0;
  /** `reducedMotion()`, read once a frame: it asks the system, so no draw has to ask again. */
  private reduced = false;
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
  /** The Section the band's edges travel from and when they set off, null while it fades in place. */
  private sectionFrom: Section | null = null;
  private spanAt = -Infinity;
  /** The notice the panel is drawn for, which outlives `notice` by its fade, and when it changed. */
  private shownNotice: string | null = null;
  private noticeOn = false;
  private noticeAt = -Infinity;
  /**
   * What the harmony panels drew last frame, slot by slot, how they are taking the chord that came
   * after it, when that began, and the panels leaving their slots while they fade out.
   */
  private shownRows: (LaneChord | undefined)[] = [];
  private change: 'slide' | 'enter' | 'fade' = 'slide';
  private changeAt = -Infinity;
  private leaving: { chord: LaneChord; slot: number }[] = [];
  /** When the walk last changed, which is what tells a Loop toggle from a seek. */
  private walkAt = -Infinity;
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
    this.lastResets = engine.resets;
    this.lastWraps = engine.wraps;
    // The range spans both hands, so a change of hands never re-lays the keyboard out.
    this.range = keyRange(engine.notes, engine.settings);
    this.measure();
    this.layout = keyLayout(this.range[0], this.range[1], this.size.width || 1);
    this.shownLayout = this.layout;
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(canvas);
    // The canvas never scrolls itself, so the wheel is the lane's own: it moves the view in ticks.
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        // A trackpad pinch reaches the page as a ctrl-wheel, and WebKit sends gesture events for
        // the same pinch: the gesture leads, so a ctrl-wheel close behind one is the pinch again.
        if (event.ctrlKey) {
          const since = performance.timeOrigin + performance.now() - this.gestureAt;
          if (since >= GESTURE_MS) this.zoom(event.deltaY);
          return;
        }
        // Wheel up looks ahead: the view goes later in the play, so the blocks travel down the lane.
        if (this.pxPerTick > 0) this.moveView(-event.deltaY / this.pxPerTick);
      },
      { passive: false, signal: this.listeners.signal },
    );
    // WebKit's own pinch, which zooms the page unless it is turned down; its scale drives the same
    // zoom, for a web view that sends these and no ctrl-wheel.
    for (const name of ['gesturestart', 'gesturechange', 'gestureend']) {
      canvas.addEventListener(
        name,
        (event) => {
          event.preventDefault();
          const scale = (event as GestureEvent).scale;
          this.gestureAt = performance.timeOrigin + performance.now();
          // Spreading the fingers grows the scale, and the beats in view shrink by that ratio.
          if (event.type === 'gesturechange' && this.pinchScale > 0 && scale > 0) {
            this.zoom(Math.log(this.pinchScale / scale) / ZOOM_RATE);
          }
          this.pinchScale = event.type === 'gestureend' ? 0 : scale;
        },
        { passive: false, signal: this.listeners.signal },
      );
    }
    // A click seeks to the step nearest where it landed and leaves the view standing, as a wheel
    // does. The keyboard under the lane is not time, so a click on it asks for nothing.
    canvas.addEventListener(
      'click',
      (event) => {
        if (this.pxPerTick <= 0 || this.laneH <= 0) return;
        const y = event.clientY - canvas.getBoundingClientRect().top;
        if (y >= this.laneH) return;
        const resets = this.engine.resets;
        this.onSeek?.({ tick: this.view + (this.laneH - y) / this.pxPerTick });
        // Only a seek the play took holds the view: a performance turns the click down.
        this.holdView = this.engine.resets !== resets;
      },
      { signal: this.listeners.signal },
    );
  }

  /** Stops watching the canvas, which is what a screen leaving the lane behind must call. */
  dispose(): void {
    this.resize.disconnect();
    this.listeners.abort();
    clearTimeout(this.lookTimer);
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

  /** Lays the keyboard out for the range setting and sets the keys off to their new places. */
  setRange(): void {
    this.layoutFrom = this.reduced ? null : this.layout;
    this.layoutAt = performance.timeOrigin + performance.now();
    this.range = keyRange(this.engine.notes, this.engine.settings);
    this.layout = keyLayout(this.range[0], this.range[1], this.size.width || 1);
  }

  /**
   * Feedback at the key: a ring for a hit or an extra. A miss shows on the block and the sheet.
   * `now` is the engine's wall clock, the timeline every strike and `resolvedAt` is stamped on.
   */
  effect(event: PlayEvent, now: number): void {
    if (event.verdict !== 'hit' && event.verdict !== 'extra') return;
    // The hit's ring is anchored where its block stood, so it must be measured as the key goes
    // down; the clock of the last frame is near enough over one frame.
    const note = event.verdict === 'hit' ? this.engine.notes[event.noteIndex] : undefined;
    this.effects.push({
      kind: event.verdict,
      midi: event.midi,
      start: now,
      velocity: event.velocity,
      dTick: note ? note.tick - this.view : 0,
    });
  }

  /**
   * One frame. Nothing is kept between frames but the effects still playing out. `now` is the
   * engine's wall clock, not the raw animation clock: the age of every mark is read against
   * `resolvedAt`, which the engine stamps from the strike that settled the note.
   */
  frame(snap: Snapshot, windowTicks: number, now: number): void {
    this.now = now;
    this.playedTick = snap.playedTick;
    this.reduced = reducedMotion();
    const wallStep = now - this.before;
    const step = Math.min(wallStep, MAX_STEP_MS);
    this.sinceWall = this.before;
    const sinceTick = this.beforeTick;
    this.before = now;
    this.beforeTick = snap.playedTick;
    this.stepView(snap, sinceTick, wallStep, windowTicks);
    if (this.engine.settings.hands !== this.hands) {
      this.handsBefore = this.hands;
      this.hands = this.engine.settings.hands;
      this.handsAt = this.reduced ? -Infinity : now;
    }
    const section = this.engine.section;
    // A band already up travels to its new bars; the first band of all fades in where it belongs.
    if (section && this.sectionOn && this.shownSection && !sameSpan(section, this.shownSection)) {
      this.sectionFrom = this.reduced ? null : this.shownSection;
      this.spanAt = now;
    }
    if (section) this.shownSection = section;
    if (this.sectionOn !== (section !== null)) {
      this.sectionOn = section !== null;
      this.sectionAt = this.reduced ? -Infinity : now;
    }
    if (this.notice) this.shownNotice = this.notice;
    if (this.noticeOn !== (this.notice !== null)) {
      this.noticeOn = this.notice !== null;
      this.noticeAt = this.reduced ? -Infinity : now;
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
      // A canvas that changed size puts every key straight where it now belongs.
      this.layout = keyLayout(this.range[0], this.range[1], width);
      this.layoutFrom = null;
    }
    const travel = clamp((now - this.layoutAt) / RANGE_MS, 0, 1);
    if (travel === 1) this.layoutFrom = null;
    this.shownLayout = this.layoutFrom
      ? blendLayout(this.layoutFrom, this.layout, easeInOut(travel))
      : this.layout;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    while (this.effects.length > 0 && now - this.effects[0]!.start > RING_MS) this.effects.shift();

    const laneH = Math.max(height - KEYBOARD_H, 40);
    this.laneH = laneH;
    // Pixels per beat come from the window, not from the lane, so dragging the split shows more or
    // fewer beats and never stretches a note.
    const reference = Math.max(
      (this.size.windowHeight - TOP_BAR) * (1 - DEFAULT_SPLIT) - KEYBOARD_H,
      120,
    );
    const pxPerTick = reference / Math.max(this.look.lookaheadBeats, 1) / TICKS_PER_QUARTER;
    this.pxPerTick = pxPerTick;

    this.stepParticles(step, laneH);
    this.heldKeys(laneH, sinceTick, step);
    this.groundOwed += this.reduced ? 0 : (step / 1000) * GRIND_PER_S;
    this.groundDue = Math.floor(this.groundOwed);
    this.groundOwed -= this.groundDue;
    if (!this.reduced) {
      for (const effect of this.effects) {
        if (effect.kind === 'hit' && effect.start > this.sinceWall) this.burst(effect, laneH);
      }
    }
    if (this.particles.length > SPECK_CAP) {
      this.particles.splice(0, this.particles.length - SPECK_CAP);
    }
    for (const [midi, at] of this.blinks) if (now - at > BLINK_MS) this.blinks.delete(midi);
    for (const [midi, press] of this.presses) {
      if (!press.down && now - press.at > RELEASE_MS) this.presses.delete(midi);
    }

    ctx.fillStyle = tone(PAPER, this.dark);
    ctx.fillRect(0, 0, width, height);

    if (this.engine.walk !== this.walk) {
      this.walk = this.engine.walk;
      this.bars = barsOf(this.engine.score, this.walk);
      this.jumps = jumpsOf(this.engine.score, this.walk);
      this.chords = chordsOf(this.engine.score.harmony, this.walk);
      this.walkAt = now;
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
    ctx.restore();

    this.drawNowLine(width, laneH, pxPerTick, windowTicks * 2 * pxPerTick);
    // The panels stand over the now-line, and the lane clips them so one leaving slides off the top.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, laneH);
    ctx.clip();
    this.drawHarmony(width, loop);
    ctx.restore();
    this.drawSplashes(laneH);
    this.drawRings(laneH, pxPerTick);
    drawKeyboard(
      ctx,
      this.shownLayout,
      laneH,
      this.dark,
      this.look.keyLabels,
      this.keyFill,
      this.keyDepth,
    );
    this.drawParticles();
    if (this.shownNotice) this.drawNotice(width, laneH);
  }

  /**
   * Where the lane looks this frame. A jump of the clock the frame's own time cannot explain is a
   * seek: its whole distance goes into the offset, so the lane holds still and glides to the new
   * place instead of appearing there. A start of motion, a seek and the end of the detach window
   * after a scroll all set the view rolling back onto the clock.
   */
  private stepView(snap: Snapshot, sinceTick: number, wallStep: number, windowTicks: number): void {
    const engine = this.engine;
    // Ticks the clock could have covered in this frame's own time, at twice the tempo it stands at
    // so a tempo change inside the frame never reads as a seek.
    const rate = windowTicks / Math.max(engine.settings.matchingWindowMs, 1);
    const reach = Math.max(wallStep, 0) * rate * 2 + 1;
    const reset = engine.resets !== this.lastResets;
    const wrapped = engine.wraps !== this.lastWraps;
    this.lastResets = engine.resets;
    this.lastWraps = engine.wraps;
    const jump = jumpOf(sinceTick, snap.playedTick, reach, reset, wrapped);
    this.offset += jump;

    const running = snap.state === 'running' || snap.state === 'counting-in';
    const began = running && !this.lastRunning;
    this.lastRunning = running;
    const settled = this.glideAt === -Infinity;
    const detached = settled && running && this.now - this.scrolledAt >= DETACH_MS;
    if (reset && this.holdView) {
      // A click seek wants the notes left where they are, so the view detaches as a wheel
      // leaves it and rides the clock again only after the detach window. The now-line marks the
      // clock, so it holds where it stood and travels to the tick that was clicked instead.
      this.holdView = false;
      this.glideAt = -Infinity;
      this.scrolledAt = this.now;
      this.lineFrom = this.lineLag + jump;
      this.lineAt = this.now;
    } else if (this.offset !== 0 && ((reset && !wrapped) || began || detached)) {
      this.glideFrom = this.offset;
      this.glideAt = this.now;
    }
    if (this.glideAt > -Infinity) {
      const left = glideLeft((this.now - this.glideAt) / GLIDE_MS);
      this.offset = this.reduced ? 0 : this.glideFrom * left;
      if (this.offset === 0) this.glideAt = -Infinity;
    }
    if (this.lineAt > -Infinity) {
      const left = glideLeft((this.now - this.lineAt) / GLIDE_MS);
      this.lineLag = this.reduced ? 0 : this.lineFrom * left;
      if (this.lineLag === 0) this.lineAt = -Infinity;
    }
    this.view = snap.playedTick + this.offset;
  }

  /**
   * Moves the view by ticks and holds it there, which cancels the glide. It stops a bar under the
   * first bar line of the play and at the last one, so the wheel never scrolls into nothing.
   */
  private moveView(by: number): void {
    const first = this.bars[0];
    const last = this.bars[this.bars.length - 1];
    const floor = first ? first.tick - (first.endTick - first.tick) : 0;
    const ceiling = Math.max(last?.tick ?? floor, floor);
    this.offset = clamp(this.view + by, floor, ceiling) - this.playedTick;
    this.glideAt = -Infinity;
    this.scrolledAt = performance.timeOrigin + performance.now();
  }

  /**
   * Takes the lookahead through one step of a pinch and reports it once the pinch stands still. The
   * view is the tick at the foot of the lane, so the new scale spreads the lane about the now-line.
   */
  private zoom(deltaY: number): void {
    this.look.lookaheadBeats = zoomLookahead(this.look.lookaheadBeats, deltaY);
    clearTimeout(this.lookTimer);
    this.lookTimer = window.setTimeout(() => {
      // Tenths of a beat, because the gear shows this number and takes it back.
      this.onLook?.({ lookaheadBeats: Math.round(this.look.lookaheadBeats * 10) / 10 });
    }, LOOK_SETTLE_MS);
  }

  /** Lane y of a played tick: the view stands at the foot of the lane and time falls towards it. */
  private y(tick: number, laneH: number, pxPerTick: number): number {
    return laneH - (tick - this.view) * pxPerTick;
  }

  private drawGrid(
    width: number,
    laneH: number,
    pxPerTick: number,
    floor: number,
    ceiling: number,
  ): void {
    const ctx = this.ctx;
    const top = Math.min(this.view + laneH / pxPerTick, ceiling);
    ctx.font = '11px ui-monospace, monospace';
    ctx.lineWidth = 1;
    for (const bar of this.bars) {
      if (bar.endTick < this.view || bar.tick < floor) continue;
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

  /**
   * The count-in: one line per beat left, falling to the now-line where the music starts. A beat is
   * spent once the clock crosses its tick, which is the moment the engine clicks it: from there the
   * line holds the place it stood at and fades out, while its number pops and outlives it.
   */
  private drawCountIn(width: number, laneH: number, pxPerTick: number, beats: number[]): void {
    const live = new Set<number>();
    for (let i = 0; i < beats.length; i++) {
      const y = Math.round(this.y(beats[i]!, laneH, pxPerTick)) + 0.5;
      // The window takes in the now-line itself, so the first beat, which opens the count-in
      // standing on it, gets a line and a number to pop.
      if (y < -20 || y > laneH + 1) continue;
      live.add(beats[i]!);
      this.countLines.set(beats[i]!, {
        y,
        label: String(beats.length - i),
        spentAt: this.countLines.get(beats[i]!)?.spentAt ?? Infinity,
      });
    }
    const ctx = this.ctx;
    ctx.font = '600 15px system-ui, sans-serif';
    ctx.strokeStyle = tone(NOW_LINE, this.dark);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1;
    for (const [tick, line] of this.countLines) {
      // The clock past the tick spends the beat; a line the engine drops has been spent as well.
      if (tick <= this.playedTick || !live.has(tick)) {
        line.spentAt = Math.min(line.spentAt, this.reduced ? -Infinity : this.now);
      }
      const since = this.now - line.spentAt;
      const gone = since / COUNT_FADE_MS;
      // The number keeps its ink through the whole pop and gives it up over the fade after it.
      const faded = (since - COUNT_POP_MS) / COUNT_FADE_MS;
      if (faded >= 1) {
        this.countLines.delete(tick);
        continue;
      }
      if (gone < 1) {
        ctx.globalAlpha = gone > 0 ? 1 - easeInOut(gone) : 1;
        ctx.beginPath();
        ctx.moveTo(0, line.y);
        ctx.lineTo(width, line.y);
        ctx.stroke();
      }
      ctx.globalAlpha = faded > 0 ? 1 - easeInOut(faded) : 1;
      const pop = this.reduced ? 1 : popAt(since / COUNT_POP_MS);
      if (pop === 1) ctx.fillText(line.label, 10, line.y - 6);
      else {
        // The number swells about its own middle, half the type's cap height over its baseline, so
        // the breath reads in place instead of pushing the glyph off the line.
        const half = ctx.measureText(line.label).width / 2;
        ctx.save();
        ctx.translate(10 + half, line.y - 11);
        ctx.scale(pop, pop);
        ctx.fillText(line.label, -half, 5);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * The lap above the divider: the same bars again, one lap higher. Nothing of it carries feedback,
   * because none of it has been played yet.
   */
  private drawNextLap(width: number, laneH: number, pxPerTick: number, loop: LoopSpan): void {
    // Drawing the lap one lap lower than the clock puts it one lap higher in the lane.
    const lap = loop.to - loop.from;
    const played = this.playedTick;
    const view = this.view;
    this.playedTick -= lap;
    this.view -= lap;
    this.drawGrid(width, laneH, pxPerTick, loop.from, loop.to);
    this.drawNotes(laneH, pxPerTick, loop.from, loop.to, false);
    this.playedTick = played;
    this.view = view;
  }

  /**
   * The Section as a tinted band over its bars, whether or not Loop gives it force. Its edges are
   * held in measure space, so a Section over repeated bars holds a band a pass and all of them
   * travel together as it changes.
   */
  private drawSection(width: number, laneH: number, pxPerTick: number): void {
    const section = this.shownSection;
    if (!section) return;
    const fade = easeInOut(clamp((this.now - this.sectionAt) / SECTION_FADE_MS, 0, 1));
    const alpha = SECTION_ALPHA * (this.sectionOn ? fade : 1 - fade);
    if (alpha <= 0) return;
    const travel = clamp((this.now - this.spanAt) / SECTION_FADE_MS, 0, 1);
    if (travel === 1) this.sectionFrom = null;
    const eased = easeInOut(travel);
    // With nowhere to travel from, both edges stand where the Section itself puts them.
    const was = this.sectionFrom ?? section;
    const from = ramp([was.from, section.from], eased);
    const to = ramp([was.to, section.to], eased);
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = tone(INK.duration, this.dark);
    for (const bar of this.bars) {
      // An edge part way through a bar covers that share of it, which is what lets it travel.
      const head = clamp(from - bar.measure, 0, 1);
      const tail = clamp(to + 1 - bar.measure, 0, 1);
      if (tail <= head) continue;
      const span = bar.endTick - bar.tick;
      const top = Math.round(this.y(bar.tick + span * tail, laneH, pxPerTick));
      const bottom = Math.round(this.y(bar.tick + span * head, laneH, pxPerTick));
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
    const top = this.view + laneH / pxPerTick;
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

  /**
   * The ink a block starts from, before its state works on it: the pitch colour of its note, or,
   * while the colouring is off, a neutral grey, with a stronger one standing in for the full tier.
   */
  private blockInk(midi: number, palette: Palette): string {
    if (this.look.colour) return colorOf(midi, palette, this.dark);
    return tone(palette === 'full' ? INK.duration : INK.miss, this.dark);
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
    const top = Math.min(this.view + laneH / pxPerTick, ceiling);
    const fade = Math.min(1, (this.now - this.handsAt) / HANDS_FADE_MS);
    // A beat of the bar the clock stands in is how far ahead a block begins to brighten.
    const beatTicks = barAt(this.bars, this.playedTick)?.beatTicks ?? TICKS_PER_QUARTER;
    for (let i = 0; i < engine.notes.length; i++) {
      const note = engine.notes[i]!;
      if (note.tick >= top) break;
      // The note that starts a tie carries the whole chain, so its continuations fall as nothing.
      if (note.tick < floor || !note.strikeable) continue;
      const bottom = this.y(note.tick, laneH, pxPerTick);
      if (bottom < -10) continue;
      const key = this.shownLayout.byMidi.get(note.midi);
      if (!key) continue;

      // A note hanging over the wrap is cut at the bar line the lap ends on.
      const y = this.y(Math.min(note.tick + note.durationTicks, ceiling), laneH, pxPerTick);
      if (y > laneH) continue;
      const state = live ? engine.noteState(i) : 'pending';
      // A strike stamped a moment after the last frame would age negative, which no curve wants.
      const age = live ? Math.max(this.now - engine.resolvedAt(i), 0) : Infinity;
      // A struck block pulses out and back about its bottom edge, which is on the now-line at the
      // strike, so the block reads as taking the blow rather than growing sideways.
      const beat = state === 'hit' && !this.reduced ? bounceAt(age / POP_MS) : 1;
      const width = key.w * (this.look.noteWidthPct / 100) * beat;
      const x = key.x + (key.w - width) / 2;
      const full = Math.max(bottom - y - this.look.gapPx, 3);
      const height = full * beat;
      const radius = Math.max(Math.min(NOTE_RADIUS, width / 3, height / 3), 0);
      // How far a miss has gone grey. It sinks and dims as it goes and stays that way in view.
      // A note the engine skipped past carries no stamp: it is grey from the frame it appears in.
      const missed = state === 'miss';
      const played = engine.resolvedAt(i) > 0;
      const gone = missed ? (this.reduced || !played ? 1 : clamp(age / MISS_MS, 0, 1)) : 0;
      const blockY = y + full - height + MISS_SINK * gone;
      // A missed block grinds sparks off the keys for as long as it is crossing them, which is
      // where the view has it; a skipped one was never played at, so it only lies there.
      const crossing = note.tick <= this.view && this.view < note.tick + note.durationTicks;
      if (missed && played && !this.reduced && (crossing || engine.resolvedAt(i) > this.sinceWall)) {
        this.grind(x, width, laneH);
      }
      // How much of a ghost the note is now: a change of hands cross-fades it over the two looks.
      const ghost = isInactiveHand(this.hands, note.hand)
        ? fade
        : isInactiveHand(this.handsBefore, note.hand)
          ? 1 - fade
          : 0;

      ctx.save();
      if (ghost < 1) {
        let fill = this.blockInk(note.midi, 'muted');
        let glow = 0;
        if (state === 'miss') fill = mix(fill, tone(INK.miss, this.dark), gone);
        else if (state === 'hit' && age < HIT_FLASH_MS && !this.reduced) {
          // The white of the strike bleeds back into the pitch colour, its glow with it.
          const flash = clamp(age / HIT_FLASH_MS, 0, 1);
          fill = mix('#ffffff', fill, flash);
          glow = 14 * (1 - flash);
        } else if (state === 'pending') {
          // The last beat of the fall brightens the block from muted to its full pitch colour.
          const near = clamp(1 - (note.tick - this.playedTick) / beatTicks, 0, 1);
          if (near > 0) fill = mix(fill, this.blockInk(note.midi, 'full'), near);
        }

        ctx.globalAlpha = (1 - ghost) * (1 - MISS_DIM * gone);
        if (glow > 0) {
          ctx.shadowColor = this.blockInk(note.midi, 'muted');
          ctx.shadowBlur = glow;
        }
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.roundRect(x, blockY, width, height, radius);
        ctx.fill();
        ctx.shadowBlur = 0;

        // The left hand carries a dark border and a dot, the right hand a thin light one, so the
        // hand a block belongs to reads without colour.
        if (note.hand === 'left') {
          ctx.strokeStyle = 'rgba(0,0,0,0.65)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.roundRect(x + 1, blockY + 1, width - 2, height - 2, Math.max(radius - 1, 1));
          ctx.stroke();
          if (height > 10 && width > 8) {
            ctx.fillStyle = 'rgba(0,0,0,0.65)';
            ctx.beginPath();
            ctx.arc(x + width / 2, blockY + 5, 2, 0, Math.PI * 2);
            ctx.fill();
          }
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.35)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(x + 0.5, blockY + 0.5, width - 1, height - 1, radius);
          ctx.stroke();
        }

        // The name rides the landing edge, where the eye already is. A block too thin or too short
        // to hold it whole grows a tab in its own fill around the name, so the name is never
        // shrunk and never left off.
        if (this.look.names) {
          const name = NOTE_NAMES[pitchClass(note.midi)]!;
          ctx.font = NAME_FONT;
          const need = ctx.measureText(name).width + NAME_PAD * 2;
          if (need > width || height < NAME_MIN_H) {
            const pillW = Math.max(need, width);
            ctx.fillStyle = fill;
            ctx.beginPath();
            ctx.roundRect(
              x + width / 2 - pillW / 2,
              blockY + height - NAME_MIN_H,
              pillW,
              NAME_MIN_H,
              NOTE_RADIUS,
            );
            ctx.fill();
          }
          ctx.fillStyle = labelInk(fill);
          ctx.textAlign = 'center';
          ctx.fillText(name, x + width / 2, blockY + height - 6);
        }
      }

      // A ghost is rhythm alone: the lane's ink, no pitch colour, no hand border, no dot.
      if (ghost > 0) {
        ctx.globalAlpha = GHOST_ALPHA * ghost;
        ctx.fillStyle = tone(INK.duration, this.dark);
        ctx.beginPath();
        ctx.roundRect(x, blockY, width, height, radius);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  /**
   * The now-line, inside a band as tall in time as the matching window: early on one side of the
   * line, late on the other. It marks the clock, so it stands at the foot of the lane while the
   * view rides it and travels with the notes while the view is off it; the keyboard is drawn over
   * the late half. Its lag carries it over to a tick that was clicked. A clock scrolled out of the
   * lane leaves no line at all.
   */
  private drawNowLine(width: number, laneH: number, pxPerTick: number, bandH: number): void {
    const at = this.y(this.playedTick + this.lineLag, laneH, pxPerTick);
    if (at < 0 || at > laneH) return;
    const ctx = this.ctx;
    const pulse = this.reduced ? { level: 0, strong: false } : pulseAt(this.bars, this.playedTick);
    const lift = pulse.level * (pulse.strong ? 2 : 1);
    ctx.fillStyle = this.dark
      ? `rgba(255,255,255,${0.07 + lift * PULSE_BAND})`
      : `rgba(0,0,0,${0.05 + lift * PULSE_BAND})`;
    ctx.fillRect(0, at - bandH / 2, width, bandH);
    ctx.strokeStyle = tone(NOW_LINE, this.dark);
    ctx.lineWidth = 1.5 + lift * PULSE_WIDTH;
    ctx.beginPath();
    ctx.moveTo(0, at - 0.75);
    ctx.lineTo(width, at - 0.75);
    ctx.stroke();
  }

  /** A hit spreads a glow of its pitch colour off the key top, the harder the stronger. */
  private drawSplashes(laneH: number): void {
    if (this.reduced) return;
    const ctx = this.ctx;
    for (const effect of this.effects) {
      if (effect.kind !== 'hit') continue;
      const age = (this.now - effect.start) / SPLASH_MS;
      if (age > 1) continue;
      const key = this.shownLayout.byMidi.get(effect.midi);
      if (!key) continue;
      const force = velocityForce(effect.velocity);
      const radius = ramp(SPLASH_RADIUS, force);
      const cx = key.x + key.w / 2;
      const color = colorOf(effect.midi, 'muted', this.dark);
      const glow = ctx.createRadialGradient(cx, laneH, 0, cx, laneH, radius);
      glow.addColorStop(0, color);
      glow.addColorStop(1, `${color}00`);
      ctx.globalAlpha = ramp(SPLASH_ALPHA, force) * (1 - age);
      ctx.fillStyle = glow;
      ctx.fillRect(cx - radius, laneH - radius, radius * 2, radius * 2);
      ctx.globalAlpha = 1;
    }
  }

  /** A hit sends a ring in its own colour up from the key top; an extra a small grey one. */
  private drawRings(laneH: number, pxPerTick: number): void {
    const ctx = this.ctx;
    for (const effect of this.effects) {
      const key = this.shownLayout.byMidi.get(effect.midi);
      if (!key) continue;
      // A ring outside its own time is no ring; a negative age would ask for a negative radius.
      const age = (this.now - effect.start) / RING_MS;
      if (!(age >= 0 && age <= 1)) continue;
      const hit = effect.kind === 'hit';
      // A hit rings where its block's bottom edge stood as the key went down: above the now-line
      // for a strike that came early, below it for one that came late.
      const y = hit ? laneH - effect.dTick * pxPerTick : laneH;
      ctx.strokeStyle = hit ? colorOf(effect.midi, 'muted', this.dark) : GREY;
      ctx.globalAlpha = 1 - age;
      ctx.lineWidth = hit ? 3 : 1.5;
      ctx.beginPath();
      ctx.arc(key.x + key.w / 2, y, (hit ? 30 : 14) * age + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /**
   * What every key owes this frame: the moment it went down or came up, the blink of a key whose
   * note has just reached its written end, and the trickle of specks a sounding key gives.
   */
  private heldKeys(laneH: number, sinceTick: number, step: number): void {
    this.owed += this.reduced ? 0 : (step / 1000) * TRICKLE_PER_S;
    const due = Math.floor(this.owed);
    this.owed -= due;
    for (const key of this.shownLayout.keys) {
      const state = this.engine.keyState(key.midi);
      const down = state !== 'base';
      if (down !== (this.presses.get(key.midi)?.down ?? false)) {
        this.presses.set(key.midi, { down, at: this.now });
      }
      const index = this.engine.heldNote(key.midi);
      if (index < 0) continue;
      const note = this.engine.notes[index]!;
      const end = note.tick + note.durationTicks;
      if (sinceTick < end && end <= this.playedTick) this.blinks.set(key.midi, this.now);
      if (state !== 'color') continue;
      for (let i = 0; i < due; i++) this.trickle(key, laneH);
    }
  }

  /** The specks a strike throws off its key top, more and faster the harder the key went down. */
  private burst(effect: Effect, laneH: number): void {
    const key = this.shownLayout.byMidi.get(effect.midi);
    if (!key) return;
    const color = colorOf(effect.midi, 'muted', this.dark);
    const count = Math.round(ramp(BURST, velocityForce(effect.velocity)));
    for (let i = 0; i < count; i++) {
      this.particles.push(
        speck(key.x + key.w / 2, laneH, BURST_SPREAD, between(60, 140), color, {
          gravity: SPECK_GRAVITY,
          wobble: 0,
          radius: between(1.5, 2.5),
          born: this.now,
          life: between(350, 500),
          alpha: 1,
        }),
      );
    }
  }

  /** The sparks a missed block grinds off the key tops it is crossing. */
  private grind(x: number, width: number, laneH: number): void {
    const color = tone(INK.miss, this.dark);
    for (let i = 0; i < this.groundDue; i++) {
      this.particles.push(
        speck(x + Math.random() * width, laneH, GRIND_SPREAD, between(40, 120), color, {
          gravity: GRIND_GRAVITY,
          wobble: 0,
          radius: between(1, 2),
          born: this.now,
          life: between(250, 400),
          alpha: 1,
        }),
      );
    }
  }

  /**
   * One speck of a sounding key, off a random point of its top edge. It wanders as it goes and
   * wears a lighter cast of its pitch, or the full tier on dark paper, so it reads over the block
   * of the same colour it rises from.
   */
  private trickle(key: Key, laneH: number): void {
    const color = this.dark
      ? colorOf(key.midi, 'full', true)
      : mix(colorOf(key.midi, 'muted', false), '#ffffff', 0.5);
    this.particles.push(
      speck(key.x + Math.random() * key.w, laneH, TRICKLE_SPREAD, between(30, 90), color, {
        gravity: 0,
        wobble: TRICKLE_DRIFT,
        radius: between(1, 1.5),
        born: this.now,
        life: between(300, 450),
        alpha: 0.6,
      }),
    );
  }

  /** Moves every speck on by one step and drops the ones that died or fell back to the keys. */
  private stepParticles(step: number, laneH: number): void {
    const seconds = step / 1000;
    let kept = 0;
    for (const spark of this.particles) {
      if (this.now - spark.born >= spark.life || spark.y > laneH) continue;
      spark.vy += spark.gravity * seconds;
      spark.x += spark.vx * seconds;
      if (spark.wobble > 0) {
        // Its own birth stands in for a phase, so no two specks wander together.
        const swing = Math.sin(((this.now - spark.born) / 1000) * TRICKLE_TURN + spark.born);
        spark.x += swing * spark.wobble * seconds;
      }
      spark.y += spark.vy * seconds;
      this.particles[kept++] = spark;
    }
    this.particles.length = kept;
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    for (const spark of this.particles) {
      ctx.globalAlpha = spark.alpha * Math.max(1 - (this.now - spark.born) / spark.life, 0);
      ctx.fillStyle = spark.color;
      ctx.beginPath();
      ctx.arc(spark.x, spark.y, spark.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * The key colour rule: a held key wears its pitch colour only while its strike matched a note
   * that is still sounding, and drains toward its base face as that note runs out. Every other
   * held key is grey. Over either lies the release blink.
   */
  private readonly keyFill = (midi: number, base: string): string => {
    const state = this.engine.keyState(midi);
    let face = base;
    if (state === 'color') face = this.sounding(midi, base);
    else if (state === 'grey') face = GREY;
    const blink = this.blinks.get(midi);
    if (blink === undefined || this.reduced) return face;
    const gone = (this.now - blink) / BLINK_MS;
    return gone >= 1 ? face : mix(colorOf(midi, 'full', this.dark), face, gone);
  };

  /** A sounding key's face, drained toward its base as its note's written duration runs out. */
  private sounding(midi: number, base: string): string {
    const color = colorOf(midi, 'muted', this.dark);
    const note = this.engine.notes[this.engine.heldNote(midi)];
    if (!note || note.durationTicks <= 0) return color;
    const over = (DRAIN_RUSH * (this.playedTick - note.tick)) / note.durationTicks;
    return mix(color, base, clamp(over, 0, 1) * DRAIN_FLOOR);
  }

  /**
   * How far down a key stands: 1 while it is held, 0 while it is up, and the overshoot of the ease
   * between the two, which sinks it past its stop and lets it bounce back up on release.
   */
  private readonly keyDepth = (midi: number): number => {
    const press = this.presses.get(midi);
    if (!press) return 0;
    if (this.reduced) return press.down ? 1 : 0;
    const over = press.down ? PRESS_MS : RELEASE_MS;
    const eased = easeOutBack(clamp((this.now - press.at) / over, 0, 1));
    return press.down ? eased : 1 - eased;
  };

  /**
   * The chord sounding now and the two after it, each on its own panel at the top right. A panel
   * counts the beats before its chord left of it: one glyph per beat, a capsule where a bar opens
   * and a dot inside it, the leftmost the beat that ends first. Only the next chord counts from the
   * clock; the one after it counts from the next chord, so that row stands still until the harmony
   * advances, when every panel slides up one slot and the one on top leaves.
   */
  private drawHarmony(width: number, loop: LoopSpan | null): void {
    if (this.chords.length === 0 || !this.look.harmony) return;
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

    const [current, ...ahead] = chordsAt(chords, this.playedTick);
    // How the row takes a new chord in force: the chord that stood next slides every panel up a
    // slot, the first panels of all rise into their slots fading in, a Loop toggle onto any other
    // chord cross-fades the row where it stands, and a seek, which may land anywhere, snaps.
    if (current?.tick !== this.shownRows[0]?.tick) {
      const advance = current !== undefined && current.tick === this.shownRows[1]?.tick;
      const first = this.shownRows.every((chord) => chord === undefined);
      // A Loop toggle lays the chords out again in this same frame; a seek leaves the list alone.
      const relaid = this.walkAt === this.now;
      this.change = advance ? 'slide' : first ? 'enter' : 'fade';
      this.changeAt = (advance || first || relaid) && !this.reduced ? this.now : -Infinity;
      const gone = this.shownRows[0];
      // A slide takes the panel on top off the row; a cross-fade holds all three where they stand.
      this.leaving = advance && gone ? [{ chord: gone, slot: -1 }] : [];
      if (this.change === 'fade' && relaid) {
        this.leaving = this.shownRows.flatMap((chord, slot) => (chord ? [{ chord, slot }] : []));
      }
    }
    this.shownRows = [current, ...ahead];

    const [next, after] = ahead;
    const rows: { chord: LaneChord; slot: number; glyphs: BeatGlyph[] }[] = [];
    if (current) rows.push({ chord: current, slot: 0, glyphs: [] });
    if (next) {
      rows.push({ chord: next, slot: 1, glyphs: beatsBefore(bars, this.playedTick, next.tick) });
    }
    // The last panel counts the beats from the next chord to itself, a row that starts ticking only
    // once that chord is the one the clock counts down to.
    if (next && after) {
      rows.push({ chord: after, slot: 2, glyphs: beatsBefore(bars, next.tick, after.tick) });
    }

    const ctx = this.ctx;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // A travelling panel comes from the slot below the one it takes, the newest from under the
    // lot; a cross-fade leaves every panel in its slot and works on alpha alone.
    const t = Math.min(1, (this.now - this.changeAt) / PANEL_SLIDE_MS);
    const travels = t < 1 && this.change !== 'fade';
    const eased = easeInOutBack(t);
    const step = (slot: number) =>
      travels
        ? lerpRect(slotRect(slot + 1, width), slotRect(slot, width), eased)
        : slotRect(slot, width);
    if (t < 1) {
      for (const gone of this.leaving) this.drawRow(step(gone.slot), gone.chord, [], 1 - t, false);
    }
    for (const row of rows) {
      // A slide fades in only the panel that has just come into the row; the others are already up.
      const alpha = this.change === 'slide' && row.slot < 2 ? 1 : t;
      this.drawRow(step(row.slot), row.chord, row.glyphs, alpha, row.slot === 1);
    }
    // The rest of the lane draws on the defaults.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  /**
   * One panel where the step it is at puts it, its name inside and its countdown left of it. Only a
   * `live` row counts down from the clock, so the glyphs of the other rest whole.
   */
  private drawRow(
    rect: PanelRect,
    chord: LaneChord,
    glyphs: BeatGlyph[],
    alpha: number,
    live: boolean,
  ): void {
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
    const rest = tone(INK.scaffolding, this.dark);
    // The flare goes to the lane's strongest ink, which is white over dark paper.
    const flare = tone(NOW_LINE, this.dark);
    glyphs.forEach((glyph, i) => {
      // How much of the burn a glyph still has, off the clock alone; a whole one is at rest.
      const left = live
        ? clamp((glyph.end - this.playedTick) / (glyph.span * BURN_SHARE), 0, 1)
        : 1;
      const burn = this.reduced ? { alpha: left, scale: 1, heat: 0 } : burnAt(left);
      ctx.globalAlpha = alpha * burn.alpha;
      ctx.fillStyle = burn.heat > 0 ? mix(rest, flare, burn.heat) : rest;
      const x = rect.x - GLYPH_GAP - GLYPH_W - (glyphs.length - 1 - i) * GLYPH_STEP;
      const tall = glyph.strong ? GLYPH_TALL : GLYPH_W;
      ctx.save();
      // Every glyph swells and collapses about its own centre, so the row holds its places.
      ctx.translate(x + GLYPH_W / 2, bottom - tall / 2);
      ctx.scale(burn.scale, burn.scale);
      ctx.beginPath();
      if (glyph.strong) {
        ctx.roundRect(-GLYPH_W / 2, -GLYPH_TALL / 2, GLYPH_W, GLYPH_TALL, GLYPH_W / 2);
      } else ctx.arc(0, 0, GLYPH_W / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
    ctx.globalAlpha = 1;
  }

  /** The panel over the keys, which fades in on a notice and out again once it goes. */
  private drawNotice(width: number, laneH: number): void {
    const eased = easeInOut(Math.min(1, (this.now - this.noticeAt) / NOTICE_FADE_MS));
    const alpha = this.noticeOn ? eased : 1 - eased;
    if (alpha <= 0) {
      this.shownNotice = null;
      return;
    }
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = tone(PANEL_FILL, this.dark);
    ctx.fillRect(0, laneH, width, KEYBOARD_H);
    ctx.fillStyle = tone(LANE_LABEL, this.dark);
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(this.shownNotice!, width / 2, laneH + KEYBOARD_H / 2 + 4);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }
}

/** What every divider says, wrap and written repeat alike. */
const backToBar = (number: number) => `↺ back to bar ${number}`;

// Dash patterns as constants, because setLineDash takes a fresh array otherwise on every frame.
const DASH = [7, 5];
const SOLID: number[] = [];

/** Two Sections over the same bars. */
const sameSpan = (a: Section, b: Section) => a.from === b.from && a.to === b.to;

/**
 * The keys part way to a new range: each one travels from where it stood, and a key the old range
 * did not hold grows out of the edge it comes in over.
 */
function blendLayout(from: KeyLayout, to: KeyLayout, t: number): KeyLayout {
  const first = from.keys[0]?.midi ?? Infinity;
  const keys = to.keys.map((key) => {
    const was = from.byMidi.get(key.midi) ?? { x: key.midi < first ? 0 : from.width, w: 0 };
    return { ...key, x: ramp([was.x, key.x], t), w: ramp([was.w, key.w], t) };
  });
  return { keys, byMidi: new Map(keys.map((key) => [key.midi, key])), width: to.width };
}

/** Where in a range a share of the way lands. */
const ramp = (range: readonly [number, number], t: number) => range[0] + (range[1] - range[0]) * t;

const between = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

/** A strike's velocity as 0 for the softest key that sounds and 1 for the hardest. */
const velocityForce = (velocity: number) => clamp((velocity - 1) / 126, 0, 1);

/** A speck leaving a key top, aimed up inside `spread` radians of straight up. */
function speck(
  x: number,
  y: number,
  spread: number,
  speed: number,
  color: string,
  rest: Pick<Speck, 'gravity' | 'wobble' | 'radius' | 'born' | 'life' | 'alpha'>,
): Speck {
  const angle = -Math.PI / 2 + between(-spread, spread);
  return { x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, color, ...rest };
}

/** The bar of the play a played tick stands in. */
function barAt(bars: LaneBar[], tick: number): LaneBar | undefined {
  return bars.find((bar) => bar.tick <= tick && tick < bar.endTick);
}

/**
 * The beat pulse at a played tick: full on the beat and gone a short way into it, `strong` on the
 * beat a bar opens with. Read off the clock alone, so it stands still whenever the clock does.
 */
export function pulseAt(bars: LaneBar[], tick: number): { level: number; strong: boolean } {
  const bar = barAt(bars, tick);
  if (!bar || bar.beatTicks <= 0) return { level: 0, strong: false };
  const since = tick - bar.tick;
  const into = since % bar.beatTicks;
  const rise = bar.beatTicks * PULSE_SHARE;
  if (into >= rise) return { level: 0, strong: false };
  return { level: 1 - into / rise, strong: since < rise };
}

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

/**
 * The beats in view after one step of a pinch, where `deltaY` is the wheel's: negative as the
 * fingers spread, which leaves fewer beats in view and draws them bigger. Unrounded, so a slow
 * pinch near the ends of the span still moves.
 */
export function zoomLookahead(beats: number, deltaY: number): number {
  return clamp(beats * Math.exp(deltaY * ZOOM_RATE), LOOK_MIN, LOOK_MAX);
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

/**
 * One swing of a struck block: out to about a quarter over its size and back through a shallow
 * undershoot, damped to nothing at the end of its time.
 */
export function bounceAt(t: number): number {
  // Outside its own time the block is its own size, whatever number the clock hands over.
  if (!(t > 0 && t < 1)) return 1;
  return 1 + POP * Math.sin(2 * Math.PI * t) * (1 - t);
}

/**
 * The breath a count-in number takes as its beat is struck: up quickly and back down slowly, and
 * its own size outside its time.
 */
export function popAt(t: number): number {
  if (!(t > 0 && t < 1)) return 1;
  const rising = t < COUNT_POP_RISE;
  const at = rising ? t / COUNT_POP_RISE : (t - COUNT_POP_RISE) / (1 - COUNT_POP_RISE);
  return 1 + COUNT_POP * (rising ? 1 - (1 - at) ** 3 : 1 - easeInOut(at));
}

/**
 * A countdown glyph burning up on its beat, from `left`, the share of its burn still to come: it
 * flares toward the strongest ink and swells as the beat runs out, then implodes to nothing.
 */
export function burnAt(left: number): { alpha: number; scale: number; heat: number } {
  // A glyph with a whole burn left, or a clock handing over a wild number, rests at its own size.
  if (!(left < 1)) return { alpha: 1, scale: 1, heat: 0 };
  if (left <= 0) return { alpha: 0, scale: 0, heat: 1 };
  if (left <= BURN_COLLAPSE) {
    const held = left / BURN_COLLAPSE;
    return { alpha: held, scale: (1 + BURN_SWELL) * held, heat: 1 };
  }
  const heat = (1 - left) / (1 - BURN_COLLAPSE);
  return { alpha: 1, scale: 1 + BURN_SWELL * heat, heat };
}

/**
 * What a frame adds to the view offset so the lane holds still under a jump of the clock. A seek
 * gives its whole distance: the engine says so by opening the notes again, or the clock moved
 * further than `reach`, the ticks the frame's own time could carry it. A loop wrap gives nothing,
 * because the lane already draws the next lap falling on through it.
 */
export function jumpOf(
  from: number,
  to: number,
  reach: number,
  reset: boolean,
  wrapped: boolean,
): number {
  if (wrapped || !(reset || Math.abs(to - from) > reach)) return 0;
  return from - to;
}

/**
 * How much of a glide's offset is left `t` of the way through it: all of it at the start, none at
 * the end, over a curve that pulls away slowly, runs, and settles slowly.
 */
export function glideLeft(t: number): number {
  if (!(t > 0)) return 1;
  return t < 1 ? 1 - easeInOut(t) : 0;
}

/** Fast out with a small overshoot, so a key settles under a finger with a bounce. */
function easeOutBack(t: number): number {
  return 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
}

/** The same slow ends, each carried a little past its mark, so the panels swing into their slots. */
function easeInOutBack(t: number): number {
  const back = 1.70158 * 1.525;
  return t < 0.5
    ? ((2 * t) ** 2 * ((back + 1) * 2 * t - back)) / 2
    : ((2 * t - 2) ** 2 * ((back + 1) * (2 * t - 2) + back) + 2) / 2;
}
