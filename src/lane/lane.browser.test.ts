import {
  BAND_IN,
  BAND_MID,
  BAND_OUT,
  DEFAULT_LANE_LOOK,
  GLIDE_MS,
  Lane,
  PANEL_INSET,
  WHEEL_SIZE,
  popAt,
  wheelAngle,
  type LaneLook,
} from '@/lane/lane';
import { KEYBOARD_H, keyLayout, type KeyLayout } from '@/lane/keyboard';
import { PAPER, colorOf, tone } from '@/look/color';
import { Engine } from '@/play/engine';
import { DEFAULT_PLAY_SETTINGS } from '@/play/settings';
import type { KeyAt } from '@/score/harmony';
import { TICKS_PER_QUARTER, type ChordEvent, type Note, type Score } from '@/score/types';
import { expect, test, vi } from 'vitest';

const BAR = 4 * TICKS_PER_QUARTER;
const WIDTH = 400;
const HEIGHT = 200;

/** `bars` bars of 4/4 with a quarter note on every beat, all on middle C. */
function scoreOf(bars = 1): Score {
  const notes: Note[] = [...Array(bars * 4).keys()].map((beat) => ({
    midi: 60,
    staff: 0,
    hand: 'right',
    onsetTick: beat * TICKS_PER_QUARTER,
    durationTicks: TICKS_PER_QUARTER,
    tiedFrom: false,
    grace: false,
    strikeable: true,
    velocity: 80,
    measureIndex: Math.floor(beat / 4),
    source: undefined as never,
  }));
  const onsets = notes.map((note) => ({
    tick: note.onsetTick,
    measureIndex: note.measureIndex,
    notes: [note],
  }));
  return {
    title: 'lane',
    composer: 'lane',
    partName: 'Piano',
    partCount: 1,
    staffCount: 1,
    onsets,
    playOrder: onsets.map((onset, i) => ({ onsetIndex: i, tick: onset.tick })),
    totalTicks: bars * BAR,
    tempoMap: [{ tick: 0, bpm: 60 }],
    hasTempo: true,
    constantTempo: true,
    hasDynamics: true,
    measures: [...Array(bars).keys()].map((i) => ({
      index: i,
      number: i + 1,
      startTick: i * BAR,
      durationTicks: BAR,
      beatsPerBar: 4,
      beatUnit: 4,
    })),
    keys: [],
    chords: [],
    harmony: [],
  };
}

function mount(
  options: { score?: Score; look?: Partial<LaneLook>; height?: number } = {},
): {
  engine: Engine;
  lane: Lane;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  const height = options.height ?? HEIGHT;
  canvas.style.cssText = `width:${WIDTH}px;height:${height}px;display:block`;
  document.body.replaceChildren(canvas);
  const engine = new Engine(options.score ?? scoreOf(), {
    ...DEFAULT_PLAY_SETTINGS,
    countInBars: 0,
    keyboardPreset: 'piece',
  });
  engine.start();
  const lane = new Lane(canvas, engine, { ...DEFAULT_LANE_LOOK, ...options.look }, false);
  return { engine, lane, canvas, ctx: canvas.getContext('2d')! };
}

/** The hex at a point of a lane's canvas. */
function hex(ctx: CanvasRenderingContext2D, x: number, y: number): string {
  const dpr = window.devicePixelRatio || 1;
  const [r, g, b] = ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data;
  return `#${[r, g, b].map((v) => v!.toString(16).padStart(2, '0')).join('')}`;
}

test('a hit stamped on another clock leaves the frame and the keyboard standing', () => {
  const laneH = HEIGHT - KEYBOARD_H;
  const { engine, lane, ctx } = mount();
  // A strike settled a thousand million seconds from the frame's clock: what the lane sees if it
  // is ever handed a clock the engine does not stamp its notes on.
  engine.advance(1000, 1e12);
  engine.strike({ midi: 60, velocity: 100, time: 1e12, on: true });
  // The ring and the splash are stamped on the frame's own clock, as the screen stamps them.
  for (const event of engine.events()) lane.effect(event, 1000);

  // A curve handed an age it was never drawn for used to throw part way down the lane, and every
  // frame died there: no keyboard, and the shadow of the block that threw left over everything.
  expect(() => lane.frame(engine.snapshot(), engine.windowTicks, 1000)).not.toThrow();

  // The keyboard is painted, and middle C wears the colour of the note the strike matched.
  expect(hex(ctx, 20, laneH + 20)).toBe(colorOf(60, 'muted', false));
  lane.dispose();
});

test('the wheel takes the view off the clock and the detach window brings it back', () => {
  const laneH = HEIGHT - KEYBOARD_H;
  const { engine, lane, canvas, ctx } = mount();
  // A column with no key of the piece under it, so only the now-line can colour it.
  const bare = WIDTH / 2;
  const line = () => hex(ctx, bare, laneH - 1);
  // The lane ages the detach window against the engine's wall clock, so the frames run on it.
  const wall = performance.timeOrigin + performance.now();
  const frame = (at: number) => lane.frame(engine.snapshot(), engine.windowTicks, wall + at);
  frame(0);
  expect(line()).not.toBe(tone(PAPER, false));

  // Wheel down looks back, so the clock rides up the lane and out of it, its line with it.
  const wheel = new WheelEvent('wheel', { deltaY: 200, cancelable: true, bubbles: true });
  canvas.dispatchEvent(wheel);
  expect(wheel.defaultPrevented).toBe(true);
  frame(10);
  expect(line()).toBe(tone(PAPER, false));

  // Two seconds after the wheel the view glides back onto the clock, and the line stands again.
  frame(2100);
  frame(2500);
  expect(line()).not.toBe(tone(PAPER, false));
  lane.dispose();
});

/** The tick the lane draws from, which a click must leave standing, and the scale it draws at. */
function viewOf(lane: Lane): number {
  return (lane as unknown as { view: number }).view;
}
function scaleOf(lane: Lane): number {
  return (lane as unknown as { pxPerTick: number }).pxPerTick;
}

/** A click at a lane y, in the page's own coordinates. */
function clickAt(canvas: HTMLCanvasElement, y: number): void {
  const box = canvas.getBoundingClientRect();
  canvas.dispatchEvent(
    new MouseEvent('click', { clientX: box.left + WIDTH / 2, clientY: box.top + y, bubbles: true }),
  );
}

test('a click up the lane seeks to the step it points at and the view stands still', () => {
  const laneH = HEIGHT - KEYBOARD_H;
  const { engine, lane, canvas } = mount();
  const wall = performance.timeOrigin + performance.now();
  const frame = (at: number) => lane.frame(engine.snapshot(), engine.windowTicks, wall + at);
  const asked: number[] = [];
  lane.onSeek = (target) => {
    if ('tick' in target) asked.push(target.tick);
    engine.seek(target);
  };
  frame(0);
  const view = viewOf(lane);
  // The y the second beat of the bar stands at, one beat of lane above the keyboard line.
  const beatTwo = laneH - TICKS_PER_QUARTER * scaleOf(lane);
  expect(beatTwo).toBeGreaterThan(0);

  clickAt(canvas, beatTwo);
  // The mouse carries whole pixels, so the tick the click names is the beat give or take one.
  expect(asked[0]).toBeCloseTo(TICKS_PER_QUARTER, -2);
  expect(engine.snapshot().playedTick).toBe(TICKS_PER_QUARTER);

  // The clock moved a beat on and the notes have not rolled anywhere: the view holds through the
  // whole of a glide, because the seek starts none for it.
  frame(10);
  expect(viewOf(lane)).toBe(view);
  frame(160);
  expect(viewOf(lane)).toBe(view);
  lane.dispose();
});

/**
 * Where the now-line's ink centres in a column with no key and no block under it, as a lane row.
 * Only the line is near black there, so weighting the rows by darkness finds it whatever the beat
 * pulse does to its width.
 */
function nowRow(ctx: CanvasRenderingContext2D, x: number, laneH: number): number {
  let sum = 0;
  let ink = 0;
  for (let y = 0; y < laneH; y++) {
    const dark = Math.max(0, 0x80 - parseInt(hex(ctx, x, y).slice(1, 3), 16));
    sum += dark * y;
    ink += dark;
  }
  return sum / ink;
}

test('a click up the lane glides the now-line to the tick it named', () => {
  const laneH = HEIGHT - KEYBOARD_H;
  const { engine, lane, canvas, ctx } = mount();
  const bare = WIDTH / 2;
  const wall = performance.timeOrigin + performance.now();
  const frame = (at: number) => lane.frame(engine.snapshot(), engine.windowTicks, wall + at);
  lane.onSeek = (target) => engine.seek(target);
  frame(0);
  const foot = nowRow(ctx, bare, laneH);
  expect(foot).toBeGreaterThan(0);
  const beatTwo = Math.round(laneH - TICKS_PER_QUARTER * scaleOf(lane));

  // The clock is a beat further on from the frame after the click, but the line is still at the
  // foot: it has the whole glide to travel to the beat that was clicked.
  clickAt(canvas, beatTwo);
  frame(10);
  expect(Math.abs(nowRow(ctx, bare, laneH) - foot)).toBeLessThan(1);

  // Half a glide on it stands between the two, and at the end of one it stands on the beat. The
  // ink is two pixels thick over its tick, so its centre lands within a pixel of the beat's row.
  frame(GLIDE_MS / 2);
  const midway = nowRow(ctx, bare, laneH);
  expect(midway).toBeLessThan(foot);
  expect(midway).toBeGreaterThan(beatTwo);
  frame(GLIDE_MS);
  expect(Math.abs(nowRow(ctx, bare, laneH) - beatTwo)).toBeLessThan(2);
  lane.dispose();
});

/** How dark a point of the canvas is, 0 for black and 255 for white. */
function level(ctx: CanvasRenderingContext2D, x: number, y: number): number {
  return parseInt(hex(ctx, x, y).slice(1, 3), 16);
}

test('a spent count-in line fades out where it stood', () => {
  const laneH = HEIGHT - KEYBOARD_H;
  const { engine, lane, ctx } = mount();
  const wall = performance.timeOrigin + performance.now();
  const frame = (at: number) => lane.frame(engine.snapshot(), engine.windowTicks, wall + at);
  frame(0);
  // One beat to count in, half a beat above the keyboard line, where no beat line of the grid is.
  const row = Math.round(laneH - (TICKS_PER_QUARTER / 2) * scaleOf(lane));
  const paper = level(ctx, WIDTH / 2, row);
  engine.countInBeats = [TICKS_PER_QUARTER / 2];
  frame(1);
  const drawn = level(ctx, WIDTH / 2, row);
  expect(drawn).toBeLessThan(paper);

  // The beat is spent: the line holds its place and gives its ink up over the fade, and the frame
  // past the end of it draws nothing at all.
  engine.countInBeats = [];
  frame(2);
  expect(level(ctx, WIDTH / 2, row)).toBe(drawn);
  frame(62);
  const going = level(ctx, WIDTH / 2, row);
  expect(going).toBeGreaterThan(drawn);
  expect(going).toBeLessThan(paper);
  frame(122);
  expect(level(ctx, WIDTH / 2, row)).toBe(paper);
  lane.dispose();
});

test('the count-in number pops on the beat the clock crosses', () => {
  const { engine, lane } = mount();
  const wall = performance.timeOrigin + performance.now();
  const frame = (at: number) => lane.frame(engine.snapshot(), engine.windowTicks, wall + at);
  // Every scale the frame asks of the canvas; with no harmony and no hit, only a pop makes one.
  const scale = vi.spyOn(CanvasRenderingContext2D.prototype, 'scale');

  // The first count-in beat stands on the now-line the clock is already at, so it is spent at once.
  engine.countInBeats = [0];
  frame(0);
  scale.mockClear();

  // Just after the beat the number is drawn larger than itself.
  frame(40);
  expect(scale.mock.calls.map((call) => call[0])).toEqual([expect.closeTo(popAt(40 / 260), 5)]);
  expect(popAt(40 / 260)).toBeGreaterThan(1);

  // Well past the pop it is drawn at its own size, which asks for no scale at all.
  scale.mockClear();
  frame(300);
  expect(scale).not.toHaveBeenCalled();
  scale.mockRestore();
  lane.dispose();
});

test('the notice over the keys fades in and out', () => {
  const laneH = HEIGHT - KEYBOARD_H;
  const { engine, lane, ctx } = mount();
  const wall = performance.timeOrigin + performance.now();
  const frame = (at: number) => lane.frame(engine.snapshot(), engine.windowTicks, wall + at);
  const key = () => level(ctx, 20, laneH + 20);
  frame(0);
  const bare = key();

  // The panel comes up from nothing over the frames after the notice arrives.
  lane.notice = 'no MIDI device';
  frame(1);
  expect(key()).toBe(bare);
  frame(76);
  const coming = key();
  expect(coming).not.toBe(bare);
  frame(151);
  const shown = key();
  expect(shown).not.toBe(coming);

  // Taking the notice away runs the same fade the other way, and the keys come back.
  lane.notice = null;
  frame(152);
  expect(key()).toBe(shown);
  frame(227);
  expect(key()).not.toBe(shown);
  frame(302);
  expect(key()).toBe(bare);
  lane.dispose();
});

test('a click on the keyboard asks for nothing', () => {
  const laneH = HEIGHT - KEYBOARD_H;
  const { engine, lane, canvas } = mount();
  const wall = performance.timeOrigin + performance.now();
  let asked = 0;
  lane.onSeek = () => {
    asked++;
  };
  lane.frame(engine.snapshot(), engine.windowTicks, wall);

  clickAt(canvas, laneH + 10);
  expect(asked).toBe(0);
  expect(engine.snapshot().playedTick).toBe(0);
  lane.dispose();
});

/** Where a key stands in the layout the lane drew its last frame on. */
function keyX(lane: Lane, midi: number): number {
  return (lane as unknown as { shownLayout: KeyLayout }).shownLayout.byMidi.get(midi)!.x;
}

test('a range change carries the keys to their new places', () => {
  const { engine, lane } = mount();
  const wall = performance.timeOrigin + performance.now();
  lane.frame(engine.snapshot(), engine.windowTicks, wall);
  const from = keyX(lane, 60);

  // Two octaves join the keyboard under middle C, which sends middle C off to the right.
  Object.assign(engine.settings, { keyboardPreset: 'custom', keyboardLo: 36, keyboardHi: 71 });
  lane.setRange();
  const set = performance.timeOrigin + performance.now();
  const frame = (at: number) => lane.frame(engine.snapshot(), engine.windowTicks, set + at);
  const to = keyLayout(36, 71, WIDTH).byMidi.get(60)!.x;
  expect(to).toBeGreaterThan(from);

  // Half the travel on it stands between the two, and at the end of it on its new place.
  frame(100);
  expect(keyX(lane, 60)).toBeGreaterThan(from);
  expect(keyX(lane, 60)).toBeLessThan(to);
  frame(200);
  expect(keyX(lane, 60)).toBe(to);
  lane.dispose();
});

/** A score in D major, so the readout and the marks both have a key to show. */
function scoreInD(): Score {
  const score = scoreOf(1);
  score.keys = [{ measureIndex: 0, sharps: 2, mode: 0 }];
  return score;
}

test('the key in force is reported once, and again only when it changes', () => {
  const { engine, lane } = mount({ score: scoreInD() });
  const seen: (KeyAt | null)[] = [];
  lane.onKey = (key) => seen.push(key);
  const wall = performance.timeOrigin + performance.now();
  lane.frame(engine.snapshot(), engine.windowTicks, wall);
  lane.frame(engine.snapshot(), engine.windowTicks, wall + 16);
  expect(seen).toEqual([{ tick: 0, sharps: 2, mode: 0 }]);
  lane.dispose();
});

test('the marks dim the keys outside the scale in force', () => {
  const laneH = HEIGHT - KEYBOARD_H;
  const { engine, lane, ctx } = mount({ score: scoreInD() });
  lane.frame(engine.snapshot(), engine.windowTicks, performance.timeOrigin + performance.now());
  // Middle C is off the D major scale, D is its tonic: the resting faces say so. The samples sit
  // where the white faces show, clear of the black keys standing over their seams.
  expect(hex(ctx, keyX(lane, 60) + 20, laneH + 40)).toBe('#dedede');
  expect(hex(ctx, keyX(lane, 62) + 28, laneH + 40)).toBe('#dedede');
  lane.dispose();

  const marks = mount({ score: scoreInD(), look: { scaleMarks: true } });
  marks.lane.frame(
    marks.engine.snapshot(),
    marks.engine.windowTicks,
    performance.timeOrigin + performance.now(),
  );
  expect(hex(marks.ctx, keyX(marks.lane, 60) + 20, laneH + 40)).toBe('#afafaf');
  expect(hex(marks.ctx, keyX(marks.lane, 62) + 28, laneH + 40)).toBe('#dedede');
  marks.lane.dispose();
});

/** How much ink a column of the lane carries, which grows with the Section band over it. */
function ink(ctx: CanvasRenderingContext2D, x: number, laneH: number): number {
  let sum = 0;
  for (let y = 0; y < laneH; y++) sum += 0xff - level(ctx, x, y);
  return sum;
}

test('the Section band travels from the bars it had to the bars it takes', () => {
  const height = 600;
  const laneH = height - KEYBOARD_H;
  // Four bars, and a long enough lookahead that all four stand in the lane at once.
  const { engine, lane, ctx } = mount({ score: scoreOf(4), look: { lookaheadBeats: 40 }, height });
  // A column with no key of the piece under it, so only the band changes what it carries.
  const bare = WIDTH / 2;
  const wall = performance.timeOrigin + performance.now();
  const frame = (at: number) => lane.frame(engine.snapshot(), engine.windowTicks, wall + at);
  engine.setSection({ from: 0, to: 0 });
  frame(0);
  frame(200);
  const one = ink(ctx, bare, laneH);
  expect(one).toBeGreaterThan(0);

  // Three bars now, and the band takes the whole fade to grow over them: the frame of the change
  // still covers one bar, half a fade on it covers two, and the end of it three.
  engine.setSection({ from: 0, to: 2 });
  frame(201);
  expect(ink(ctx, bare, laneH)).toBe(one);
  frame(301);
  const midway = ink(ctx, bare, laneH);
  frame(401);
  const three = ink(ctx, bare, laneH);
  expect(midway).toBeGreaterThan(one);
  expect(midway).toBeLessThan(three);
  lane.dispose();
});

/** The wheel's panel: a lane tall enough to hold it, and where it stands in one. */
const WHEEL_HEIGHT = 600;
const WHEEL_LEFT = WIDTH - PANEL_INSET - WHEEL_SIZE;
const WHEEL_TOP = PANEL_INSET;
const WHEEL_MID = WHEEL_SIZE / 2;

/** Every colour the wheel's panel carries, as `#rrggbb`. */
function panelColours(ctx: CanvasRenderingContext2D): Set<string> {
  const dpr = window.devicePixelRatio || 1;
  const { data } = ctx.getImageData(
    WHEEL_LEFT * dpr,
    WHEEL_TOP * dpr,
    WHEEL_SIZE * dpr,
    WHEEL_SIZE * dpr,
  );
  const seen = new Set<string>();
  for (let i = 0; i < data.length; i += 4) {
    const hex = [data[i], data[i + 1], data[i + 2]].map((v) => v!.toString(16).padStart(2, '0'));
    seen.add(`#${hex.join('')}`);
  }
  return seen;
}

/** The pitch classes of C major but for C, which every note of the test piece already wears. */
const IN_C = [2, 4, 5, 7, 9, 11];

test('the wheel faces the scale in force, and covers nothing while the setting names the panels', () => {
  const wall = performance.timeOrigin + performance.now();
  const on = mount({ height: WHEEL_HEIGHT, look: { harmony: 'wheel' } });
  // The first key of all fades in, so the band stands whole a slide after the frame it opens on.
  on.lane.frame(on.engine.snapshot(), on.engine.windowTicks, wall);
  on.lane.frame(on.engine.snapshot(), on.engine.windowTicks, wall + 250);
  const colours = panelColours(on.ctx);
  for (const pc of IN_C) expect(colours.has(colorOf(pc, 'muted', false))).toBe(true);
  // A pitch class off the scale is hollow, so its face stands nowhere in the panel.
  expect(colours.has(colorOf(6, 'muted', false))).toBe(false);
  on.lane.dispose();

  const off = mount({ height: WHEEL_HEIGHT });
  off.lane.frame(off.engine.snapshot(), off.engine.windowTicks, wall);
  off.lane.frame(off.engine.snapshot(), off.engine.windowTicks, wall + 250);
  const bare = panelColours(off.ctx);
  for (const pc of IN_C) expect(bare.has(colorOf(pc, 'muted', false))).toBe(false);
  off.lane.dispose();
});

/** Three bars that turn from C major to D major at bar 2 and to E flat major at bar 3. */
function scoreTurning(): Score {
  const score = scoreOf(3);
  score.keys = [
    { measureIndex: 0, sharps: 0, mode: 0 },
    { measureIndex: 1, sharps: 2, mode: 0 },
    { measureIndex: 2, sharps: -3, mode: 0 },
  ];
  score.tempoMap = [{ tick: 0, bpm: 480 }];
  return score;
}

test('a key change cross-fades the band, and a seek snaps it', () => {
  const { engine, lane, ctx } = mount({
    score: scoreTurning(),
    height: WHEEL_HEIGHT,
    look: { harmony: 'wheel' },
  });
  const wall = performance.timeOrigin + performance.now();
  const frame = (at: number) => lane.frame(engine.snapshot(), engine.windowTicks, wall + at);
  // F sharp belongs to D major alone, and B flat to E flat major alone.
  const sharp = colorOf(6, 'muted', false);
  const flat = colorOf(10, 'muted', false);
  frame(0);
  expect(panelColours(ctx).has(sharp)).toBe(false);

  // The clock runs into bar 2 in frames of a sixtieth of a second, which is motion and no jump.
  let at = 0;
  while (engine.snapshot().playedTick < BAR) {
    engine.advance(16);
    at += 16;
    frame(at);
  }
  // The new face takes the whole slide to come up, so it stands nowhere until the end of one.
  expect(panelColours(ctx).has(sharp)).toBe(false);
  frame(at + 125);
  expect(panelColours(ctx).has(sharp)).toBe(false);
  frame(at + 250);
  expect(panelColours(ctx).has(sharp)).toBe(true);

  // A seek may land anywhere, so the key it lands in stands in the frame it lands on.
  engine.seek({ measure: 2 });
  frame(at + 251);
  const landed = panelColours(ctx);
  expect(landed.has(flat)).toBe(true);
  expect(landed.has(sharp)).toBe(false);
  lane.dispose();
});

/** Every colour one segment carries between two radii, the band and a margin round it by default. */
function segmentColours(
  ctx: CanvasRenderingContext2D,
  pc: number,
  from = BAND_IN - 5,
  to = BAND_OUT + 10,
): Set<string> {
  const dpr = window.devicePixelRatio || 1;
  const side = WHEEL_SIZE * dpr;
  const { data } = ctx.getImageData(WHEEL_LEFT * dpr, WHEEL_TOP * dpr, side, side);
  const mid = wheelAngle(pc);
  const seen = new Set<string>();
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const dx = x / dpr - WHEEL_MID;
      const dy = y / dpr - WHEEL_MID;
      const r = Math.hypot(dx, dy);
      if (r < from || r > to) continue;
      const step = Math.atan2(dy, dx) - mid;
      if (Math.abs(Math.atan2(Math.sin(step), Math.cos(step))) > Math.PI / 12) continue;
      const i = (y * side + x) * 4;
      const hex = [data[i], data[i + 1], data[i + 2]].map((v) => v!.toString(16).padStart(2, '0'));
      seen.add(`#${hex.join('')}`);
    }
  }
  return seen;
}

/** The colour inside one segment, off the mid line its label holds and clear of its outline. */
function segmentFace(ctx: CanvasRenderingContext2D, pc: number): string {
  const angle = wheelAngle(pc) + 0.16;
  return hex(
    ctx,
    WHEEL_LEFT + WHEEL_MID + Math.cos(angle) * BAND_MID,
    WHEEL_TOP + WHEEL_MID + Math.sin(angle) * BAND_MID,
  );
}

/** Two bars of C major: the tonic, then a borrowed D flat whose root and A flat leave the key. */
function scoreBorrowing(): Score {
  const score = scoreOf(2);
  score.keys = [{ measureIndex: 0, sharps: 0, mode: 0 }];
  const chord = (bar: number, absolute: string, degree: string, tones: number[]): ChordEvent => ({
    onsetIndex: bar * 4,
    tick: bar * BAR,
    measureIndex: bar,
    absolute,
    degree,
    root: tones[0]!,
    tones,
  });
  score.harmony = [chord(0, 'C', '1', [0, 4, 7]), chord(1, 'D♭', '♭2', [1, 5, 8])];
  return score;
}

test('a chord tone outside the key wears a dashed outline of its own and no face', () => {
  const { engine, lane, ctx } = mount({
    score: scoreBorrowing(),
    height: WHEEL_HEIGHT,
    look: { harmony: 'wheel' },
  });
  const wall = performance.timeOrigin + performance.now();
  const settle = (at: number) => {
    for (const step of [0, 300, 600]) {
      lane.frame(engine.snapshot(), engine.windowTicks, wall + at + step);
    }
  };
  // The tonic chord first: a root the key holds keeps the face size means "now" is painted in.
  settle(0);
  expect(segmentFace(ctx, 0)).toBe(colorOf(0, 'full', false));

  // The borrowed chord: its root stands raised with no face of either tier, only its own colour.
  engine.seek({ measure: 1 });
  settle(1000);
  const root = segmentColours(ctx, 1);
  expect(root.has(colorOf(1, 'muted', false))).toBe(false);
  // Nothing but the chrome an untouched hollow segment leaves stands under the outline.
  expect(segmentFace(ctx, 1)).toBe(segmentFace(ctx, 6));
  expect(root.has(colorOf(1, 'full', false))).toBe(true);
  // The outline stands outside the band, so the root still takes the size that means "now".
  expect(segmentColours(ctx, 1, BAND_OUT + 1, BAND_OUT + 10).has(colorOf(1, 'full', false))).toBe(true);

  // Its A flat wears the same outline at the band's own size, and no face either.
  const third = segmentColours(ctx, 8);
  expect(third.has(colorOf(8, 'muted', false))).toBe(false);
  expect(third.has(colorOf(8, 'full', false))).toBe(true);
  expect(segmentColours(ctx, 8, 79, 88).has(colorOf(8, 'full', false))).toBe(false);
  // Its F belongs to the key, so that segment stands as it always does.
  expect(segmentColours(ctx, 5).has(colorOf(5, 'muted', false))).toBe(true);
  lane.dispose();
});

test('a pinch writes the lookahead it settled on once the fingers stop', async () => {
  const { lane, canvas } = mount();
  const written: number[] = [];
  lane.onLook = ({ lookaheadBeats }) => written.push(lookaheadBeats!);

  // A trackpad pinch reaches the page as a wheel with ctrl held, one event per step.
  for (let i = 0; i < 3; i++) {
    canvas.dispatchEvent(
      new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, cancelable: true, bubbles: true }),
    );
  }

  // The write waits for the pinch to stand still, and then names where the three steps left it.
  expect(written).toEqual([]);
  await vi.waitFor(() => expect(written.length).toBe(1));
  expect(written[0]).toBeLessThan(DEFAULT_LANE_LOOK.lookaheadBeats);
  lane.dispose();
});
