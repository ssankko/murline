import { DEFAULT_LANE_LOOK, GLIDE_MS, Lane } from '@/lane/lane';
import { KEYBOARD_H } from '@/lane/keyboard';
import { PAPER, colorOf, tone } from '@/look/color';
import { Engine } from '@/play/engine';
import { DEFAULT_PLAY_SETTINGS } from '@/play/settings';
import { TICKS_PER_QUARTER, type Note, type Score } from '@/score/types';
import { expect, test } from 'vitest';

const BAR = 4 * TICKS_PER_QUARTER;
const WIDTH = 400;
const HEIGHT = 200;

/** One bar of 4/4 with a quarter note on every beat, all on middle C. */
function scoreOf(): Score {
  const notes: Note[] = [0, 1, 2, 3].map((beat) => ({
    midi: 60,
    staff: 0,
    hand: 'right',
    onsetTick: beat * TICKS_PER_QUARTER,
    durationTicks: TICKS_PER_QUARTER,
    tiedFrom: false,
    grace: false,
    strikeable: true,
    velocity: 80,
    measureIndex: 0,
    source: undefined as never,
  }));
  const onsets = notes.map((note) => ({
    tick: note.onsetTick,
    measureIndex: 0,
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
    totalTicks: BAR,
    tempoMap: [{ tick: 0, bpm: 60 }],
    hasTempo: true,
    constantTempo: true,
    hasDynamics: true,
    measures: [
      { index: 0, number: 1, startTick: 0, durationTicks: BAR, beatsPerBar: 4, beatUnit: 4 },
    ],
    keys: [],
    chords: [],
    harmony: [],
  };
}

function mount(): {
  engine: Engine;
  lane: Lane;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px;display:block`;
  document.body.replaceChildren(canvas);
  const engine = new Engine(scoreOf(), {
    ...DEFAULT_PLAY_SETTINGS,
    countInBars: 0,
    keyboardPreset: 'piece',
  });
  engine.start();
  const lane = new Lane(canvas, engine, { ...DEFAULT_LANE_LOOK }, false);
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
