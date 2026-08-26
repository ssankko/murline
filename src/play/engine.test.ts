import { DEFAULT_PLAY_SETTINGS, type PlaySettings } from '@/play/settings';
import { TICKS_PER_QUARTER, type Measure, type Note, type Onset, type Score } from '@/score/types';
import { describe, expect, test } from 'vitest';
import { create } from './engine';

const BAR = 4 * TICKS_PER_QUARTER;

/** A Score with `bars` bars of 4/4 and a quarter-note Onset on every beat. */
function scoreOf(bars: number, tempoMap = [{ tick: 0, bpm: 60 }], hasTempo = true): Score {
  const measures: Measure[] = [];
  const onsets: Onset[] = [];
  for (let bar = 0; bar < bars; bar++) {
    measures.push({
      index: bar,
      number: bar + 1,
      startTick: bar * BAR,
      durationTicks: BAR,
      beatsPerBar: 4,
      beatUnit: 4,
    });
    for (let beat = 0; beat < 4; beat++) {
      const tick = bar * BAR + beat * TICKS_PER_QUARTER;
      onsets.push({
        tick,
        measureIndex: bar,
        notes: [note(tick, bar)],
        timestamp: undefined as never,
      });
    }
  }
  return {
    title: 'test',
    composer: 'test',
    partName: 'Piano',
    partCount: 1,
    staffCount: 2,
    onsets,
    playOrder: onsets.map((onset, i) => ({ onsetIndex: i, tick: onset.tick })),
    totalTicks: bars * BAR,
    tempoMap,
    hasTempo,
    constantTempo: tempoMap.length < 2,
    measures,
    keys: [],
    chords: [],
  };
}

function note(onsetTick: number, measureIndex: number): Note {
  return {
    midi: 60,
    staff: 0,
    hand: 'right',
    voice: 1,
    onsetTick,
    durationTicks: TICKS_PER_QUARTER,
    tieStart: false,
    tiedFrom: false,
    grace: false,
    strikeable: true,
    velocity: 80,
    measureIndex,
    source: undefined as never,
  };
}

/** The same two bars played three times: bar 1, bar 2, then bar 1 again after a backward jump. */
function withRepeat(): Score {
  const score = scoreOf(2);
  const again = score.onsets.slice(0, 4);
  score.playOrder.push(
    ...again.map((onset, i) => ({ onsetIndex: i, tick: 2 * BAR + onset.tick })),
  );
  score.totalTicks = 3 * BAR;
  return score;
}

function engine(score: Score, settings: Partial<PlaySettings> = {}) {
  return create(score, { ...DEFAULT_PLAY_SETTINGS, ...settings });
}

describe('the clock', () => {
  test('reads its speed from the tempo map entry in force', () => {
    const play = engine(
      scoreOf(3, [
        { tick: 0, bpm: 60 },
        { tick: BAR, bpm: 120 },
      ]),
    );
    play.start();

    // A quarter note a second under the first mark, twice that under the second.
    play.advance(1000);
    expect(play.snapshot().playedTick).toBe(TICKS_PER_QUARTER);
    play.advance(3000);
    expect(play.snapshot().playedTick).toBe(BAR);
    play.advance(1000);
    expect(play.snapshot().playedTick).toBe(BAR + 2 * TICKS_PER_QUARTER);
  });

  test('splits one advance across a tempo change', () => {
    const play = engine(
      scoreOf(3, [
        { tick: 0, bpm: 60 },
        { tick: BAR, bpm: 120 },
      ]),
    );
    play.start();

    // Four seconds to the bar line at 60, then one more second at 120.
    play.advance(5000);
    expect(play.snapshot().playedTick).toBe(BAR + 2 * TICKS_PER_QUARTER);
  });

  test('percent scales every tempo mark', () => {
    const play = engine(
      scoreOf(3, [
        { tick: 0, bpm: 60 },
        { tick: BAR, bpm: 120 },
      ]),
      { tempoValue: 200 },
    );
    play.start();

    play.advance(2000);
    expect(play.snapshot().playedTick).toBe(BAR);
    play.advance(1000);
    expect(play.snapshot().playedTick).toBe(BAR + 4 * TICKS_PER_QUARTER);
  });

  test('a piece with no tempo mark runs at 120 BPM', () => {
    const play = engine(scoreOf(3, [{ tick: 0, bpm: 60 }], false));
    play.start();

    play.advance(1000);
    expect(play.snapshot().playedTick).toBe(2 * TICKS_PER_QUARTER);
  });

  test('stands still until the play starts', () => {
    const play = engine(scoreOf(2));
    play.advance(1000);
    expect(play.snapshot()).toMatchObject({ state: 'idle', playedTick: 0 });
  });
});

describe('the played tick against the score', () => {
  test('past a backward jump it names the Onset of the new pass', () => {
    const play = engine(withRepeat());
    play.start();
    // Inside the third beat of the repeated first bar.
    play.advance(10_500);

    expect(play.snapshot()).toMatchObject({
      stepIndex: 10,
      onsetIndex: 2,
      measureIndex: 0,
    });
  });

  test('before the jump the same played tick names the first pass', () => {
    const play = engine(withRepeat());
    play.start();
    play.advance(2500);

    expect(play.snapshot()).toMatchObject({ stepIndex: 2, onsetIndex: 2, measureIndex: 0 });
  });
});

describe('the lifecycle', () => {
  test('pause rewinds to the start of the bar the cursor stands in', () => {
    const play = engine(withRepeat());
    play.start();
    play.advance(10_500);
    play.pause();

    expect(play.snapshot()).toMatchObject({ state: 'paused', playedTick: 2 * BAR });
  });

  test('resume runs on from the bar start', () => {
    const play = engine(withRepeat());
    play.start();
    play.advance(10_500);
    play.pause();
    play.resume();
    play.advance(1000);

    expect(play.snapshot()).toMatchObject({ state: 'running', playedTick: 2 * BAR + 960 });
  });

  test('restart parks at the start point', () => {
    const play = engine(scoreOf(2));
    play.start();
    play.advance(2500);
    play.restart();

    expect(play.snapshot()).toMatchObject({ state: 'idle', playedTick: 0 });
  });

  test('the end of the piece parks at the start point', () => {
    const play = engine(scoreOf(2));
    play.start();
    play.advance(60_000);

    expect(play.snapshot()).toMatchObject({ state: 'idle', playedTick: 0 });
  });

  test('the end tick holds the last written duration plus the matching window', () => {
    const play = engine(scoreOf(2));

    // Eight quarter notes, then 150 ms of window, which at 60 BPM is 0.15 of a quarter note.
    expect(play.endTick).toBeCloseTo(8 * TICKS_PER_QUARTER + 0.15 * TICKS_PER_QUARTER, 6);
  });
});
