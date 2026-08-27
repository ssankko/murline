import { DEFAULT_LANE_LOOK, Lane } from '@/lane/lane';
import { KEYBOARD_H } from '@/lane/keyboard';
import { colorOf } from '@/look/color';
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

function mount(): { engine: Engine; lane: Lane; ctx: CanvasRenderingContext2D } {
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
  return { engine, lane, ctx: canvas.getContext('2d')! };
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
