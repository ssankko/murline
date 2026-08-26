import { DEFAULT_PLAY_SETTINGS, type PlaySettings } from '@/play/settings';
import { TICKS_PER_QUARTER, type Measure, type Note, type Onset, type Score } from '@/score/types';
import { describe, expect, test } from 'vitest';
import { create, type Engine } from './engine';

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
    harmony: [],
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

/** A Score of one Onset per entry, over the bars of `scoreOf`. */
function scoreFrom(spec: { tick: number; notes: Partial<Note>[] }[], bars = 2): Score {
  const score = scoreOf(bars);
  score.onsets = spec.map((entry) => {
    const measureIndex = Math.floor(entry.tick / BAR);
    return {
      tick: entry.tick,
      measureIndex,
      notes: entry.notes.map((n) => ({ ...note(entry.tick, measureIndex), ...n })),
      timestamp: undefined as never,
    };
  });
  score.playOrder = score.onsets.map((onset, i) => ({ onsetIndex: i, tick: onset.tick }));
  return score;
}

/** At 60 BPM one quarter note is a second, so 150 ms of matching window is 144 ticks. */
const BEAT_MS = 1000;

function down(play: Engine, midi: number, ms: number): void {
  play.strike({ midi, velocity: 80, time: ms, on: true });
}

function up(play: Engine, midi: number, ms: number): void {
  play.strike({ midi, velocity: 0, time: ms, on: false });
}

/** One Onset on the second beat, which puts a whole window on either side of it. */
function onBeatTwo(notes: Partial<Note>[] = [{}], settings: Partial<PlaySettings> = {}) {
  const play = engine(scoreFrom([{ tick: TICKS_PER_QUARTER, notes }]), settings);
  play.start();
  return play;
}

describe('matching a strike in Flow mode', () => {
  test('the nearest unmatched note of that pitch takes the strike', () => {
    const play = onBeatTwo();
    play.advance(BEAT_MS);
    down(play, 60, BEAT_MS);

    expect(play.events()).toEqual([
      { verdict: 'hit', midi: 60, noteIndex: 0, time: BEAT_MS },
    ]);
    expect(play.noteState(0)).toBe('hit');
  });

  test('a strike on the far edge of the window still counts', () => {
    for (const at of [BEAT_MS - 150, BEAT_MS + 150]) {
      const play = onBeatTwo();
      play.advance(at);
      down(play, 60, at);
      expect(play.events()[0]).toMatchObject({ verdict: 'hit', noteIndex: 0 });
    }
  });

  test('a strike one millisecond past the edge is an extra', () => {
    for (const at of [BEAT_MS - 151, BEAT_MS + 151]) {
      const play = onBeatTwo();
      play.advance(at);
      down(play, 60, at);
      expect(play.events().at(-1)).toMatchObject({ verdict: 'extra', noteIndex: -1 });
    }
  });

  test('with two notes of the pitch in the window the nearer one takes it', () => {
    const play = engine(
      scoreFrom([
        { tick: TICKS_PER_QUARTER, notes: [{}] },
        { tick: TICKS_PER_QUARTER + 96, notes: [{}] },
      ]),
    );
    play.start();
    play.advance(1060);
    down(play, 60, 1060);

    expect(play.events()[0]).toMatchObject({ verdict: 'hit', noteIndex: 1 });
  });

  test('a match is final, so the same key again is an extra', () => {
    const play = onBeatTwo();
    play.advance(BEAT_MS);
    down(play, 60, BEAT_MS);
    up(play, 60, BEAT_MS + 10);
    down(play, 60, BEAT_MS + 20);

    expect(play.events().map((e) => e.verdict)).toEqual(['hit', 'extra']);
  });

  test('a key no note asks for is an extra', () => {
    const play = onBeatTwo();
    play.advance(BEAT_MS);
    down(play, 67, BEAT_MS);

    expect(play.events()[0]).toMatchObject({ verdict: 'extra', midi: 67, noteIndex: -1 });
  });

  test('a grace note absorbs its strike instead of counting it', () => {
    const play = onBeatTwo([{ midi: 61, grace: true, durationTicks: 0 }]);
    play.advance(BEAT_MS);
    down(play, 61, BEAT_MS);

    expect(play.events()[0]).toMatchObject({ verdict: 'absorbed', midi: 61 });
  });

  test('an inactive-hand note absorbs its strike', () => {
    const play = onBeatTwo([{ midi: 50, hand: 'left', staff: 1 }], { hands: 'right' });
    play.advance(BEAT_MS);
    down(play, 50, BEAT_MS);

    expect(play.events()[0]).toMatchObject({ verdict: 'absorbed', midi: 50 });
    expect(play.noteState(0)).toBe('pending');
  });

  test('with hands left a right-hand strike is absorbed and its note never misses', () => {
    const play = onBeatTwo([{ midi: 60, hand: 'right', staff: 0 }], { hands: 'left' });
    play.advance(BEAT_MS);
    down(play, 60, BEAT_MS);

    expect(play.events()).toEqual([
      { verdict: 'absorbed', midi: 60, noteIndex: -1, time: BEAT_MS },
    ]);
    expect(play.keyState(60)).toBe('grey');

    // The window closes over a note nobody was asked to play, and nothing comes of it.
    play.advance(BEAT_MS);
    expect(play.events()).toEqual([]);
    expect(play.noteState(0)).toBe('pending');
  });

  test('the same note is a hit when its hand is active', () => {
    const play = onBeatTwo([{ midi: 50, hand: 'left', staff: 1 }], { hands: 'both' });
    play.advance(BEAT_MS);
    down(play, 50, BEAT_MS);

    expect(play.events()[0]).toMatchObject({ verdict: 'hit', noteIndex: 0 });
  });

  test('a strike before the play runs lights the key and nothing else', () => {
    const play = engine(scoreFrom([{ tick: TICKS_PER_QUARTER, notes: [{}] }]));
    down(play, 60, 0);

    expect(play.events()).toEqual([]);
    expect(play.keyState(60)).toBe('grey');
  });
});

describe('a window that closes unmatched', () => {
  test('marks the note a miss once', () => {
    const play = onBeatTwo();
    play.advance(BEAT_MS + 149);
    expect(play.events()).toEqual([]);

    play.advance(2);
    expect(play.events()).toEqual([
      { verdict: 'miss', midi: 60, noteIndex: 0, time: BEAT_MS + 151 },
    ]);
    expect(play.noteState(0)).toBe('miss');

    play.advance(500);
    expect(play.events()).toEqual([]);
  });

  test('never fires for the inactive hand', () => {
    const play = onBeatTwo([{ midi: 50, hand: 'left', staff: 1 }], { hands: 'right' });
    play.advance(BEAT_MS + 200);

    expect(play.events()).toEqual([]);
    expect(play.noteState(0)).toBe('pending');
  });

  test('never fires for a grace note', () => {
    const play = onBeatTwo([{ midi: 61, grace: true, durationTicks: 0 }]);
    play.advance(BEAT_MS + 200);

    expect(play.events()).toEqual([]);
  });
});

describe('the colour of a held key', () => {
  test('is the pitch colour while the matched note sounds, then grey', () => {
    const play = onBeatTwo();
    play.advance(BEAT_MS);
    down(play, 60, BEAT_MS);
    expect(play.keyState(60)).toBe('color');

    // The note is a quarter note, so it stops sounding a second after its Onset.
    play.advance(999);
    expect(play.keyState(60)).toBe('color');
    play.advance(2);
    expect(play.keyState(60)).toBe('grey');

    up(play, 60, 3000);
    expect(play.keyState(60)).toBe('base');
  });

  test('is grey from the first frame for an extra', () => {
    const play = onBeatTwo();
    play.advance(BEAT_MS);
    down(play, 67, BEAT_MS);

    expect(play.keyState(67)).toBe('grey');
  });

  test('is grey for an absorbed inactive-hand strike', () => {
    const play = onBeatTwo([{ midi: 50, hand: 'left', staff: 1 }], { hands: 'right' });
    play.advance(BEAT_MS);
    down(play, 50, BEAT_MS);

    expect(play.keyState(50)).toBe('grey');
  });
});
