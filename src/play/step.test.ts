import { arrowBack, stepTarget } from '@/play/step';
import { TICKS_PER_QUARTER, type Measure, type Onset, type Score } from '@/score/types';
import { describe, expect, test } from 'vitest';

const BAR = 4 * TICKS_PER_QUARTER;

/** Two 4/4 bars with an Onset on every beat, the first bar played again after them. */
function withRepeat(): Score {
  const measures: Measure[] = [0, 1].map((bar) => ({
    index: bar,
    number: bar + 1,
    startTick: bar * BAR,
    durationTicks: BAR,
    beatsPerBar: 4,
    beatUnit: 4,
  }));
  const onsets: Onset[] = [];
  for (const measure of measures) {
    for (let beat = 0; beat < 4; beat++) {
      onsets.push({
        tick: measure.startTick + beat * TICKS_PER_QUARTER,
        measureIndex: measure.index,
        notes: [],
      });
    }
  }
  const playOrder = onsets.map((onset, i) => ({ onsetIndex: i, tick: onset.tick }));
  playOrder.push(...onsets.slice(0, 4).map((onset, i) => ({ onsetIndex: i, tick: 2 * BAR + onset.tick })));
  return {
    title: 'test',
    composer: '',
    partName: 'Piano',
    partCount: 1,
    staffCount: 1,
    onsets,
    playOrder,
    totalTicks: 3 * BAR,
    tempoMap: [{ tick: 0, bpm: 60 }],
    hasTempo: true,
    constantTempo: true,
    hasDynamics: false,
    measures,
    keys: [],
    chords: [],
    harmony: [],
  };
}

const score = withRepeat();
const step = (playedTick: number, back: boolean, bar: boolean) =>
  stepTarget(score, score.playOrder, playedTick, back, bar);

describe('one Onset', () => {
  test('forward takes the first Onset after the position, back the one behind it', () => {
    expect(step(TICKS_PER_QUARTER, false, false)).toEqual({ onset: 2 });
    expect(step(TICKS_PER_QUARTER, true, false)).toEqual({ onset: 0 });
    // Between two Onsets both ends are the Onsets it stands between.
    expect(step(TICKS_PER_QUARTER + 100, false, false)).toEqual({ onset: 2 });
    expect(step(TICKS_PER_QUARTER + 100, true, false)).toEqual({ onset: 1 });
  });

  test('walks into the repeat and holds at the ends', () => {
    // Past the last written Onset the walk comes round to the first bar again.
    expect(step(2 * BAR - TICKS_PER_QUARTER, false, false)).toEqual({ onset: 0 });
    expect(step(0, true, false)).toBeNull();
    expect(step(3 * BAR - TICKS_PER_QUARTER, false, false)).toBeNull();
  });
});

describe('one bar', () => {
  test('back opens the bar the position stands in, then reaches the bar before', () => {
    expect(step(BAR + TICKS_PER_QUARTER, true, true)).toEqual({ measure: 1 });
    expect(step(BAR, true, true)).toEqual({ measure: 0 });
  });

  test('forward takes the next bar line, the repeated bar included', () => {
    expect(step(TICKS_PER_QUARTER, false, true)).toEqual({ measure: 1 });
    expect(step(BAR, false, true)).toEqual({ measure: 0 });
  });

  test('holds at the first and the last bar', () => {
    expect(step(0, true, true)).toBeNull();
    expect(step(2 * BAR + TICKS_PER_QUARTER, false, true)).toBeNull();
  });
});

describe('which arrows', () => {
  test('the lane takes Up and Down, the sheet Left and Right, elsewhere all four', () => {
    expect(arrowBack('ArrowUp', 'lane')).toBe(false);
    expect(arrowBack('ArrowDown', 'lane')).toBe(true);
    expect(arrowBack('ArrowLeft', 'lane')).toBeNull();
    expect(arrowBack('ArrowRight', 'sheet')).toBe(false);
    expect(arrowBack('ArrowLeft', 'sheet')).toBe(true);
    expect(arrowBack('ArrowUp', 'sheet')).toBeNull();
    expect(arrowBack('ArrowDown', null)).toBe(true);
    expect(arrowBack('ArrowRight', null)).toBe(false);
    expect(arrowBack('Escape', null)).toBeNull();
  });
});
