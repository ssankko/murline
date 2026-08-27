import { DEFAULT_PLAY_SETTINGS, type PlaySettings } from '@/play/settings';
import { TICKS_PER_QUARTER, type Measure, type Note, type Onset, type Score } from '@/score/types';
import { describe, expect, test } from 'vitest';
import { Engine } from './engine';

const BAR = 4 * TICKS_PER_QUARTER;

/** Where the cursor stands in the Score, read off the walk as a screen that draws it does. */
function where(play: Engine): { onsetIndex: number; measureIndex: number } {
  const onsetIndex = play.walk[play.snapshot().stepIndex]!.onsetIndex;
  return { onsetIndex, measureIndex: play.score.onsets[onsetIndex]!.measureIndex };
}

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
    hasDynamics: true,
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
    onsetTick,
    durationTicks: TICKS_PER_QUARTER,
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

/** Four bars whose play order plays bar 1 again before it goes on: bars 1, 2, 1, 3, 4. */
function repeatOfBarOne(): Score {
  const score = scoreOf(4);
  const step = (onsetIndex: number, tick: number) => ({ onsetIndex, tick });
  score.playOrder = [
    ...score.onsets.slice(0, 8).map((onset, i) => step(i, onset.tick)),
    ...score.onsets.slice(0, 4).map((onset, i) => step(i, 2 * BAR + onset.tick)),
    ...score.onsets.slice(8).map((onset, i) => step(i + 8, BAR + onset.tick)),
  ];
  score.totalTicks = 5 * BAR;
  return score;
}

/** The count-in is off unless a test asks for it, so a play starts on the first beat. */
function engine(score: Score, settings: Partial<PlaySettings> = {}) {
  return new Engine(score, { ...DEFAULT_PLAY_SETTINGS, countInBars: 0, ...settings });
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

    expect(play.snapshot().stepIndex).toBe(10);
    expect(where(play)).toEqual({ onsetIndex: 2, measureIndex: 0 });
  });

  test('before the jump the same played tick names the first pass', () => {
    const play = engine(withRepeat());
    play.start();
    play.advance(2500);

    expect(play.snapshot().stepIndex).toBe(2);
    expect(where(play)).toEqual({ onsetIndex: 2, measureIndex: 0 });
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

  test('pause opens the notes of the bar again, so a resume expects them afresh', () => {
    const play = engine(scoreOf(2));
    play.start();
    // Two beats into bar 2, with the first note of that bar left behind as a miss.
    play.advance(6000);
    expect(play.noteState(4)).toBe('miss');

    play.pause();
    expect(play.noteState(4)).toBe('pending');

    play.resume();
    down(play, 60, 6000);
    expect(play.noteState(4)).toBe('hit');
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

  test('restart opens every note the run behind it settled', () => {
    const play = engine(scoreOf(2));
    play.start();
    play.advance(2500);
    expect(play.noteState(0)).toBe('miss');

    play.restart();
    expect(play.noteState(0)).toBe('pending');
  });

  test('a start at a later bar skips what lies behind it, and says nothing about it', () => {
    const play = engine(scoreOf(3));
    play.seek({ measure: 2 });
    play.start();
    play.advance(1000);

    expect(play.noteState(0)).toBe('miss');
    expect(play.resolvedAt(0)).toBe(0);
    expect(play.events().every((event) => event.noteIndex >= 8)).toBe(true);
  });

  test('the end of the piece parks at the start point', () => {
    const play = engine(scoreOf(2));
    play.start();
    play.advance(60_000);

    expect(play.snapshot()).toMatchObject({ state: 'idle', playedTick: 0 });
  });

  test('says when it opened the notes again, and when a practice ran off the end', () => {
    const play = engine(scoreOf(2));
    play.start();
    const opened = play.resets;
    play.advance(6000);
    expect(play.resets).toBe(opened);
    expect(play.finishes).toBe(0);

    // A backward seek reopens everything behind the cursor, marks and all.
    play.seek({ measure: 0 });
    expect(play.resets).toBeGreaterThan(opened);

    play.advance(60_000);
    expect(play.finishes).toBe(1);
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

    // A hit carries the velocity of the strike behind it, which the lane spends on its splash.
    expect(play.events()).toEqual([
      { verdict: 'hit', midi: 60, noteIndex: 0, time: BEAT_MS, velocity: 80 },
    ]);
    expect(play.noteState(0)).toBe('hit');
    expect(play.heldNote(60)).toBe(0);
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
      { verdict: 'absorbed', midi: 60, noteIndex: -1, time: BEAT_MS, velocity: 80 },
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
      { verdict: 'miss', midi: 60, noteIndex: 0, time: BEAT_MS + 151, velocity: 0 },
    ]);
    expect(play.noteState(0)).toBe('miss');

    play.advance(500);
    expect(play.events()).toEqual([]);
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
    // The key names no note, so nothing of it drains or blinks in the lane.
    expect(play.heldNote(67)).toBe(-1);
  });

  test('is grey once a new walk has renumbered the notes under the held key', () => {
    const play = engine(withRepeat());
    play.start();
    // Nine seconds in is the third bar, bar 1 played again, whose notes stand past the end of the
    // linear walk a looping Section builds.
    play.advance(9000);
    down(play, 60, 9000);
    expect(play.keyState(60)).toBe('color');

    play.setSection({ from: 0, to: 1 });
    play.setLoop(true);

    expect(play.keyState(60)).toBe('grey');
  });
});

/** A Wait mode play over hand-written Onsets, already running. */
function waiting(
  spec: { tick: number; notes: Partial<Note>[] }[],
  settings: Partial<PlaySettings> = {},
) {
  const play = engine(scoreFrom(spec), { mode: 'wait', ...settings });
  play.start();
  return play;
}

/** One Onset on the second beat asking for a C major third. */
const CHORD = [{ tick: TICKS_PER_QUARTER, notes: [{ midi: 60 }, { midi: 64 }] }];

describe('Wait mode', () => {
  test('a tie continuation is neither required nor blocking', () => {
    const play = waiting([
      {
        tick: TICKS_PER_QUARTER,
        notes: [{ midi: 60, tiedFrom: true, strikeable: false }, { midi: 62 }],
      },
    ]);
    play.advance(2 * BEAT_MS);
    expect(play.snapshot().stopped).toBe(true);

    // The player re-articulates the note tied into this Onset while playing the chord.
    down(play, 60, 2 * BEAT_MS);
    down(play, 62, 2 * BEAT_MS);

    expect(play.snapshot().stopped).toBe(false);
  });

  test('the cursor stops at an Onset the player has not satisfied, however long it lasts', () => {
    const play = waiting(CHORD);
    play.advance(2 * BEAT_MS);

    expect(play.snapshot()).toMatchObject({
      state: 'running',
      playedTick: TICKS_PER_QUARTER,
      stopped: true,
    });

    play.advance(10 * BEAT_MS);
    expect(play.snapshot().playedTick).toBe(TICKS_PER_QUARTER);
  });

  test('a chord struck inside the togetherness window releases the stop', () => {
    const play = waiting(CHORD);
    play.advance(1500);
    down(play, 60, 1500);
    down(play, 64, 1700);

    expect(play.snapshot().stopped).toBe(false);
    play.advance(500);
    expect(play.snapshot().playedTick).toBe(TICKS_PER_QUARTER + 480);
  });

  test('a chord spread wider than the togetherness window waits for a re-strike', () => {
    const play = waiting(CHORD);
    play.advance(1500);
    down(play, 60, 1500);
    down(play, 64, 1800);
    expect(play.snapshot().stopped).toBe(true);

    up(play, 60, 1900);
    up(play, 64, 1900);
    down(play, 60, 2000);
    down(play, 64, 2100);
    expect(play.snapshot().stopped).toBe(false);
  });

  test('a stray key held blocks the Onset until it comes up', () => {
    const play = waiting(CHORD);
    play.advance(1500);
    down(play, 67, 1500);
    down(play, 60, 1600);
    down(play, 64, 1600);
    expect(play.snapshot().stopped).toBe(true);

    up(play, 67, 1700);
    expect(play.snapshot().stopped).toBe(false);
  });

  test('a key held from an earlier Onset does not block', () => {
    const play = waiting([
      { tick: TICKS_PER_QUARTER, notes: [{ midi: 60 }] },
      { tick: 2 * TICKS_PER_QUARTER, notes: [{ midi: 64 }] },
    ]);
    play.advance(1500);
    down(play, 60, 1500);
    play.advance(1000);
    expect(play.snapshot()).toMatchObject({ playedTick: 2 * TICKS_PER_QUARTER, stopped: true });

    // 60 is still down and never comes up.
    down(play, 64, 2500);
    expect(play.snapshot().stopped).toBe(false);
  });

  test('an Onset of tie continuations only is not a stop', () => {
    const play = waiting([
      { tick: TICKS_PER_QUARTER, notes: [{ midi: 60, tiedFrom: true, strikeable: false }] },
      { tick: 2 * TICKS_PER_QUARTER, notes: [{ midi: 64 }] },
    ]);
    play.advance(3000);

    expect(play.snapshot()).toMatchObject({ playedTick: 2 * TICKS_PER_QUARTER, stopped: true });
  });

  test('an Onset of the inactive hand alone is not a stop', () => {
    const play = waiting(
      [
        { tick: TICKS_PER_QUARTER, notes: [{ midi: 50, hand: 'left', staff: 1 }] },
        { tick: 2 * TICKS_PER_QUARTER, notes: [{ midi: 64 }] },
      ],
      { hands: 'right' },
    );
    play.advance(3000);

    expect(play.snapshot()).toMatchObject({ playedTick: 2 * TICKS_PER_QUARTER, stopped: true });
  });

  test('a strike on an inactive-hand note at the stop is absorbed', () => {
    const play = waiting(
      [
        {
          tick: TICKS_PER_QUARTER,
          notes: [{ midi: 60 }, { midi: 50, hand: 'left', staff: 1 }],
        },
      ],
      { hands: 'right' },
    );
    play.advance(1500);
    down(play, 50, 1500);

    expect(play.events().at(-1)).toMatchObject({ verdict: 'absorbed', midi: 50 });
    // An absorbed key is not a blocking key.
    down(play, 60, 1600);
    expect(play.snapshot().stopped).toBe(false);
  });

  test('a strike before the window opens is an extra', () => {
    const play = waiting([{ tick: TICKS_PER_QUARTER, notes: [{ midi: 60 }] }]);
    play.advance(800);
    down(play, 60, 800);

    expect(play.events().at(-1)).toMatchObject({ verdict: 'extra', midi: 60, noteIndex: -1 });
    play.advance(400);
    expect(play.snapshot().stopped).toBe(true);
  });

  test('an Onset satisfied before the cursor arrives is not a stop', () => {
    const play = waiting([{ tick: TICKS_PER_QUARTER, notes: [{ midi: 60 }] }]);
    play.advance(900);
    down(play, 60, 900);
    play.advance(200);

    expect(play.snapshot()).toMatchObject({ playedTick: 1056, stopped: false });
  });

  test('a stop does not open the next Onset window', () => {
    const play = waiting([
      { tick: TICKS_PER_QUARTER, notes: [{ midi: 60 }] },
      { tick: 2 * TICKS_PER_QUARTER, notes: [{ midi: 64 }] },
    ]);
    play.advance(1500);
    down(play, 64, 1500);

    expect(play.events().at(-1)).toMatchObject({ verdict: 'extra', midi: 64 });
  });

  test('a repeated pitch needs a fresh strike', () => {
    const play = waiting([
      { tick: TICKS_PER_QUARTER, notes: [{ midi: 60 }] },
      { tick: 2 * TICKS_PER_QUARTER, notes: [{ midi: 60 }] },
    ]);
    play.advance(1500);
    down(play, 60, 1500);
    play.advance(1000);
    expect(play.snapshot()).toMatchObject({ playedTick: 2 * TICKS_PER_QUARTER, stopped: true });

    up(play, 60, 2600);
    down(play, 60, 2700);
    expect(play.snapshot().stopped).toBe(false);
  });

  test('a Flow mode play switched to Wait stops at the Onsets from there on', () => {
    const play = engine(
      scoreFrom([
        { tick: TICKS_PER_QUARTER, notes: [{ midi: 60 }] },
        { tick: 2 * TICKS_PER_QUARTER, notes: [{ midi: 64 }] },
      ]),
    );
    play.start();
    play.advance(1500);
    expect(play.snapshot().stopped).toBe(false);

    play.settings.mode = 'wait';
    play.advance(1000);
    expect(play.snapshot()).toMatchObject({ playedTick: 2 * TICKS_PER_QUARTER, stopped: true });
  });

  test('switching to Flow releases the stop', () => {
    const play = waiting(CHORD);
    play.advance(2 * BEAT_MS);
    expect(play.snapshot().stopped).toBe(true);

    play.settings.mode = 'flow';
    play.advance(500);
    expect(play.snapshot()).toMatchObject({ playedTick: TICKS_PER_QUARTER + 480, stopped: false });
  });

  test('taking the hand off a stop lets the cursor go on', () => {
    const play = waiting([
      { tick: TICKS_PER_QUARTER, notes: [{ midi: 50, hand: 'left', staff: 1 }] },
    ]);
    play.advance(1500);
    expect(play.snapshot().stopped).toBe(true);

    play.settings.hands = 'right';
    play.advance(200);
    expect(play.snapshot()).toMatchObject({ playedTick: TICKS_PER_QUARTER + 192, stopped: false });
  });

  test('the window the cursor band draws is the matching window at play tempo', () => {
    // The band the sheet and the lane draw is this many ticks wide: at 60 BPM 150 ms is 144 ticks,
    // and at twice the tempo the same milliseconds cover twice the ticks.
    expect(engine(scoreFrom(CHORD)).windowTicks).toBe(144);
    expect(engine(scoreFrom(CHORD), { tempoValue: 200 }).windowTicks).toBe(288);
  });

  test('pause makes the Onsets of the bar it drops back to stops again', () => {
    const play = waiting([
      { tick: TICKS_PER_QUARTER, notes: [{ midi: 60 }] },
      { tick: 2 * TICKS_PER_QUARTER, notes: [{ midi: 64 }] },
    ]);
    play.advance(1500);
    down(play, 60, 1500);
    play.advance(400);
    play.pause();
    play.resume();
    play.advance(2000);

    expect(play.snapshot()).toMatchObject({ playedTick: TICKS_PER_QUARTER, stopped: true });
  });
});

/** Two bars of 6/8, one Onset on each bar line: a compound meter beats in dotted quarters. */
function compound(): Score {
  const score = scoreOf(2);
  const bar = 6 * (TICKS_PER_QUARTER / 2);
  score.measures = [0, 1].map((index) => ({
    index,
    number: index + 1,
    startTick: index * bar,
    durationTicks: bar,
    beatsPerBar: 6,
    beatUnit: 8,
  }));
  score.onsets = [0, 1].map((index) => ({
    tick: index * bar,
    measureIndex: index,
    notes: [{ ...note(index * bar, index), durationTicks: bar }],
  }));
  score.playOrder = score.onsets.map((onset, i) => ({ onsetIndex: i, tick: onset.tick }));
  score.totalTicks = 2 * bar;
  return score;
}

describe('the metronome', () => {
  test('clicks every beat of the bar, and nothing while it is off', () => {
    const play = engine(scoreOf(2), { metronome: true, countInBars: 0 });
    play.start();

    // Four beats of 4/4 at 60 BPM: one click a second, the first on the downbeat.
    play.advance(500);
    expect(play.beats()).toBe(1);
    play.advance(1000);
    expect(play.beats()).toBe(1);

    play.settings.metronome = false;
    play.advance(2000);
    expect(play.beats()).toBe(0);
  });

  test('says which beat opens the bar and how long one beat lasts', () => {
    const play = engine(scoreOf(2), { metronome: true, countInBars: 0 });
    play.start();

    // 4/4 at 60 BPM: the bar opens on a strong beat and the three after it are weak.
    play.advance(500);
    expect(play.beats()).toBe(1);
    expect(play.strongBeat).toBe(true);
    expect(play.beatMs).toBeCloseTo(1000, 6);
    for (let beat = 0; beat < 3; beat++) {
      play.advance(1000);
      expect(play.beats()).toBe(1);
      expect(play.strongBeat).toBe(false);
    }

    // The next bar line is strong again.
    play.advance(1000);
    expect(play.beats()).toBe(1);
    expect(play.strongBeat).toBe(true);
  });

  test('a compound meter beats in dotted quarters', () => {
    const play = engine(compound(), { metronome: true, countInBars: 0 });
    play.start();

    // 6/8 at 60 BPM: a dotted quarter is 1.5 s, so two beats to the bar.
    play.advance(3000);
    expect(play.beats()).toBe(3);
    play.advance(1500);
    expect(play.beats()).toBe(1);
  });

  test('the clock standing still freezes it mid-beat and leaves the grid where it was', () => {
    const play = engine(scoreOf(2), { metronome: true, countInBars: 0 });
    play.start();
    play.advance(1500);
    expect(play.beats()).toBe(2);

    // The clock stands still half a beat in: no click, and the grid is not moved on.
    for (let i = 0; i < 5; i++) play.advance(0);
    expect(play.beats()).toBe(0);

    play.advance(499);
    expect(play.beats()).toBe(0);
    play.advance(2);
    expect(play.beats()).toBe(1);
    expect(play.snapshot().playedTick).toBeCloseTo(2 * TICKS_PER_QUARTER + 0.96, 6);
  });

  test('a Wait mode stop freezes it mid-beat and starts no count-in of its own', () => {
    const play = waiting(CHORD, { metronome: true, countInBars: 1 });

    // The count-in first, then the downbeat and the beat the cursor stops at.
    play.advance(4000);
    expect(play.beats()).toBe(4);
    play.advance(1500);
    expect(play.beats()).toBe(2);
    expect(play.snapshot()).toMatchObject({ state: 'running', stopped: true });

    // Standing at the stop: no click, no state of its own, and the grid stays where it was.
    play.advance(3000);
    expect(play.beats()).toBe(0);
    expect(play.snapshot()).toMatchObject({
      state: 'running',
      stopped: true,
      playedTick: TICKS_PER_QUARTER,
    });

    down(play, 60, 8500);
    down(play, 64, 8500);
    play.advance(1000);
    expect(play.beats()).toBe(1);
    expect(play.snapshot().playedTick).toBeCloseTo(2 * TICKS_PER_QUARTER, 6);
  });

  test('a pause clicks nothing and the bar it resumes into clicks its beats again', () => {
    const play = engine(scoreOf(2), { metronome: true, countInBars: 0 });
    play.start();
    play.advance(1500);
    expect(play.beats()).toBe(2);

    play.pause();
    play.advance(3000);
    expect(play.beats()).toBe(0);

    // The cursor fell back to the bar line, so the played tick meets those beats a second time.
    play.resume();
    play.advance(1000);
    expect(play.beats()).toBe(2);
  });
});

/**
 * One 4/4 bar, then a 3/4 bar that opens with a quarter rest, so the second bar's first Onset
 * stands a beat after its bar line.
 */
function restThenThreeFour(): Score {
  const score = scoreOf(1);
  score.measures.push({
    index: 1,
    number: 2,
    startTick: BAR,
    durationTicks: 3 * TICKS_PER_QUARTER,
    beatsPerBar: 3,
    beatUnit: 4,
  });
  for (const beat of [1, 2]) {
    const tick = BAR + beat * TICKS_PER_QUARTER;
    score.onsets.push({ tick, measureIndex: 1, notes: [note(tick, 1)] });
  }
  score.playOrder = score.onsets.map((onset, i) => ({ onsetIndex: i, tick: onset.tick }));
  score.totalTicks = BAR + 3 * TICKS_PER_QUARTER;
  return score;
}

describe('the count-in', () => {
  test('runs its bar of beats before the play moves, and clicks them with the metronome off', () => {
    const play = engine(scoreOf(2), { countInBars: 1, metronome: false });
    play.start();

    expect(play.snapshot()).toMatchObject({ state: 'counting-in', playedTick: -4 * TICKS_PER_QUARTER });
    play.advance(3999);
    expect(play.beats()).toBe(4);
    expect(play.snapshot().state).toBe('counting-in');

    play.advance(2);
    expect(play.snapshot().state).toBe('running');
    expect(play.snapshot().playedTick).toBeCloseTo(0.96, 6);
  });

  test('counts down with no strong beat of its own, and leads to a strong downbeat', () => {
    const play = engine(scoreOf(2), { countInBars: 1, metronome: true });
    play.start();

    // The count-in beats at the tempo of the bar it leads into.
    expect(play.beatMs).toBeCloseTo(1000, 6);
    play.advance(500);
    for (let beat = 0; beat < 4; beat++) {
      expect(play.beats()).toBe(1);
      expect(play.strongBeat).toBe(false);
      play.advance(1000);
    }

    // The count-in ran out inside that last second, so the beat it leads to is the downbeat.
    expect(play.beats()).toBe(1);
    expect(play.strongBeat).toBe(true);
  });

  test('offsets the expected times: a strike lands on its note a count-in later', () => {
    const play = engine(scoreFrom([{ tick: TICKS_PER_QUARTER, notes: [{}] }]), { countInBars: 1 });
    play.start();

    // A strike during the count-in reaches no note; it only lights its key.
    play.advance(2000);
    down(play, 60, 2000);
    expect(play.events()).toEqual([]);
    expect(play.keyState(60)).toBe('grey');
    up(play, 60, 2100);

    // The Onset of the second beat now falls a count-in bar later than the play began.
    play.advance(2000 + BEAT_MS);
    down(play, 60, 5000);
    expect(play.events()).toEqual([
      { verdict: 'hit', midi: 60, noteIndex: 0, time: 5000, velocity: 80 },
    ]);
  });

  test('a pause during it returns to Idle where it was counting to', () => {
    const play = engine(scoreOf(2), { countInBars: 1 });
    play.start();
    play.advance(1000);
    play.pause();

    expect(play.snapshot()).toMatchObject({ state: 'idle', playedTick: 0 });
  });

  test('runs again before a resume', () => {
    const play = engine(scoreOf(2), { countInBars: 1 });
    play.start();
    play.advance(4000);
    play.advance(1000);
    play.pause();
    play.resume();

    expect(play.snapshot().state).toBe('counting-in');
  });

  test('a pause during it leaves the start point where it was counting to', () => {
    const play = engine(scoreOf(4), { countInBars: 1 });
    play.start();
    play.advance(4000 + 8500);
    play.pause();
    play.resume();
    play.pause();

    expect(play.snapshot().playedTick).toBe(2 * BAR);

    // The next start counts in to bar 3, where the cursor is parked.
    play.start();
    expect(play.snapshot().playedTick).toBe(2 * BAR - 4 * TICKS_PER_QUARTER);
  });

  test('skips the bar it counts over, so only what it leads to is open', () => {
    const play = engine(scoreOf(3), { countInBars: 1 });
    play.start();
    // The count-in, then five beats: one bar and a beat into the piece.
    play.advance(4000 + 5000);
    play.pause();
    play.resume();

    // The resume counts over bar 1, which the cursor stands past; bar 2 is open again.
    expect(play.snapshot().state).toBe('counting-in');
    expect(play.noteState(3)).toBe('miss');
    expect(play.resolvedAt(3)).toBe(0);
    expect(play.noteState(4)).toBe('pending');
  });

  test('counts the meter of a bar that opens with a rest', () => {
    const play = engine(restThenThreeFour(), { countInBars: 1 });
    play.seek({ measure: 1 });
    play.start();

    // Three beats of the 3/4 bar the count-in leads into, not four of the 4/4 bar before it.
    expect(play.countInBeats).toHaveLength(3);
    expect(play.snapshot().playedTick).toBe(BAR - 3 * TICKS_PER_QUARTER);
  });
});

describe('what a practice leaves behind', () => {
  test('nothing when the cursor never passed an Onset', () => {
    const play = engine(scoreOf(2), { countInBars: 0 });
    play.start();
    play.advance(100);
    play.abort();

    expect(play.takePractice()).toBeNull();
  });

  test('its motion once the cursor passed one, and nothing a second time', () => {
    const play = engine(scoreOf(2), { countInBars: 0 });
    play.start();
    play.advance(1100);
    play.abort();

    expect(play.takePractice()).toEqual({ startedAt: 1100, seconds: 1.1 });
    expect(play.takePractice()).toBeNull();
  });

  test('nothing at a pause, which is not a stop', () => {
    const play = engine(scoreOf(2), { countInBars: 0 });
    play.start();
    play.advance(1100);
    play.pause();

    expect(play.takePractice()).toBeNull();
  });

  test('a duration that leaves out the count-in and the pauses', () => {
    const play = engine(scoreOf(2), { countInBars: 1 });
    play.start();
    play.advance(4000);
    play.advance(2000);
    play.pause();
    play.advance(5000);
    play.resume();
    play.advance(4000);
    play.advance(1000);
    play.abort();

    expect(play.takePractice()?.seconds).toBeCloseTo(3, 6);
  });

  test('its motion when a pause during a later count-in ends the play', () => {
    const play = engine(scoreOf(2), { countInBars: 1 });
    play.start();
    play.advance(4000);
    play.advance(2000);
    play.pause();
    play.resume();
    play.advance(1000);
    play.pause();

    expect(play.snapshot().state).toBe('idle');
    expect(play.takePractice()?.seconds).toBeCloseTo(2, 6);
  });
});

describe('a performance', () => {
  /** Two Onsets a beat apart, the second a different pitch, and a bar of room after them. */
  function twoNotes(settings: Partial<PlaySettings> = {}) {
    const play = engine(
      scoreFrom([
        { tick: 0, notes: [{ midi: 60 }] },
        { tick: TICKS_PER_QUARTER, notes: [{ midi: 62 }] },
      ]),
      settings,
    );
    play.arm();
    return play;
  }

  test('arms Idle at bar one and stops the practice it interrupted', () => {
    const play = engine(scoreOf(2));
    play.start();
    play.advance(2000);
    play.arm();

    expect(play.snapshot()).toMatchObject({ state: 'idle', kind: 'performance', playedTick: 0 });
    expect(play.takePractice()?.seconds).toBeCloseTo(2, 6);
  });

  test('runs at the tempo it started with, whatever the settings say next', () => {
    const play = twoNotes();
    play.start();
    play.settings.tempoValue = 200;
    play.advance(1000);

    // The same write on a practice doubles the speed; here the clock keeps the tempo of the start.
    expect(play.snapshot().playedTick).toBeCloseTo(TICKS_PER_QUARTER, 6);
  });

  test('ends at the end tick and leaves its numbers', () => {
    const play = twoNotes();
    play.start();
    down(play, 60, 0);
    play.advance(BEAT_MS);
    up(play, 60, BEAT_MS);
    down(play, 62, BEAT_MS);
    play.advance(BEAT_MS);
    up(play, 62, 2 * BEAT_MS);

    play.advance(149);
    expect(play.snapshot().state).toBe('running');
    play.advance(1);
    expect(play.snapshot().state).toBe('ended');

    const record = play.takePerformance();
    expect(record).toMatchObject({ tempoMode: 'percent', tempoValue: 100, hands: 'both' });
    expect(record?.seconds).toBeCloseTo(2.15, 6);
    expect(record?.grade).toEqual({
      grade: 100,
      expected: 2,
      matched: 2,
      extras: 0,
      meanTiming: 100,
      meanVelocity: 100,
      meanRelease: 100,
    });
    expect(play.takePerformance()).toBeNull();
  });

  test('counts a missed note and a stray key against the grade', () => {
    const play = twoNotes();
    play.start();
    down(play, 60, 0);
    play.advance(BEAT_MS);
    up(play, 60, BEAT_MS);
    down(play, 67, BEAT_MS);
    play.advance(BEAT_MS + 150);

    // One note of two played, one extra: a full note grade over three.
    expect(play.takePerformance()?.grade).toMatchObject({
      grade: 33,
      expected: 2,
      matched: 1,
      extras: 1,
    });
  });

  test('grades the active hand only', () => {
    const play = engine(
      scoreFrom([
        {
          tick: 0,
          notes: [
            { midi: 60, hand: 'right', staff: 0 },
            { midi: 50, hand: 'left', staff: 1 },
          ],
        },
      ]),
      { hands: 'left' },
    );
    play.arm();
    play.start();
    down(play, 50, 0);
    play.advance(BEAT_MS);
    up(play, 50, BEAT_MS);
    play.advance(150);

    expect(play.takePerformance()?.grade).toMatchObject({
      grade: 100,
      expected: 1,
      matched: 1,
      extras: 0,
    });
  });

  test('a key still down at the end is graded without its release', () => {
    // The strike is 20 units under the ideal, so velocity grades 0 and the rest carries the note.
    const held = engine(scoreFrom([{ tick: 0, notes: [{ midi: 60 }] }]));
    held.arm();
    held.start();
    held.strike({ midi: 60, velocity: 60, time: 0, on: true });
    held.advance(1150);

    expect(held.takePerformance()?.grade).toMatchObject({ grade: 88, meanRelease: 0 });

    const released = engine(scoreFrom([{ tick: 0, notes: [{ midi: 60 }] }]));
    released.arm();
    released.start();
    released.strike({ midi: 60, velocity: 60, time: 0, on: true });
    released.advance(BEAT_MS);
    up(released, 60, BEAT_MS);
    released.advance(150);

    expect(released.takePerformance()?.grade).toMatchObject({ grade: 90, meanRelease: 100 });
  });

  test('an aborted run leaves no record of any kind', () => {
    const play = twoNotes();
    play.start();
    down(play, 60, 0);
    play.advance(BEAT_MS);
    play.abort();

    expect(play.takePerformance()).toBeNull();
    expect(play.takePractice()).toBeNull();
    expect(play.snapshot()).toMatchObject({ state: 'idle', kind: 'practice', playedTick: 0 });
  });

  test('the pause disc ends it the way Stop does', () => {
    const play = twoNotes();
    play.start();
    play.advance(BEAT_MS);
    play.pause();

    expect(play.snapshot()).toMatchObject({ state: 'idle', kind: 'practice' });
    expect(play.takePerformance()).toBeNull();
  });

  test('a start opens every note, whatever the practice before it left', () => {
    const play = engine(scoreOf(2));
    play.seek({ measure: 1 });
    play.start();
    play.advance(2000);
    expect(play.noteState(0)).toBe('miss');

    play.arm();
    play.start();
    expect(play.notes.every((_, i) => play.noteState(i) === 'pending')).toBe(true);
  });

  test('Play again from the end runs a fresh performance', () => {
    const play = twoNotes();
    play.start();
    play.advance(3000);
    expect(play.snapshot().state).toBe('ended');
    play.takePerformance();

    play.start();
    expect(play.snapshot()).toMatchObject({ state: 'running', kind: 'performance', playedTick: 0 });
    expect(play.noteState(0)).toBe('pending');
  });
});

describe('seek', () => {
  test('a bar click while Idle moves the start point', () => {
    const play = engine(scoreOf(3));
    play.seek({ measure: 1 });

    expect(play.snapshot().playedTick).toBe(BAR);
    play.start();
    play.advance(1000);
    play.abort();
    expect(play.snapshot().playedTick).toBe(BAR);
  });

  test('a note click goes to its Onset', () => {
    const play = engine(scoreOf(3));
    play.seek({ onset: 6 });

    expect(play.snapshot().playedTick).toBe(BAR + 2 * TICKS_PER_QUARTER);
  });

  test('the clock carries on at once while Running', () => {
    const play = engine(scoreOf(3));
    play.start();
    play.advance(1000);
    play.seek({ measure: 2 });

    expect(play.snapshot().state).toBe('running');
    play.advance(1000);
    expect(play.snapshot().playedTick).toBe(2 * BAR + TICKS_PER_QUARTER);
  });

  test('a repeated bar goes to the occurrence nearest the played tick', () => {
    const play = engine(withRepeat());
    play.start();
    play.advance(9000);
    play.seek({ measure: 0 });

    // Bar 1 is played at tick 0 and again at 2 bars in; the cursor stood past the second one.
    expect(play.snapshot().playedTick).toBe(2 * BAR);
  });

  test('a played tick goes to the step nearest it, in the pass that tick falls in', () => {
    const play = engine(withRepeat());
    play.start();
    // The clock stands in the first pass of bar 1; the tick names the second pass, so it wins
    // however far it lies from the clock.
    play.seek({ tick: 2 * BAR + TICKS_PER_QUARTER + 10 });

    expect(play.snapshot().playedTick).toBe(2 * BAR + TICKS_PER_QUARTER);
  });

  test('the first occurrence on a tie', () => {
    const play = engine(withRepeat());
    play.start();
    // Exactly between the two passes of bar 1.
    play.advance(4000);
    play.seek({ measure: 0 });

    expect(play.snapshot().playedTick).toBe(0);
  });

  test('skips what it jumps over and opens what lies ahead', () => {
    const play = engine(scoreOf(3));
    play.start();
    play.advance(100);
    down(play, 60, 100);
    expect(play.noteState(0)).toBe('hit');

    // Bar 3 opens at note 8: the eight notes jumped over are skipped, with no stamp behind them.
    play.seek({ measure: 2 });
    expect(play.noteState(0)).toBe('miss');
    expect(play.resolvedAt(0)).toBe(0);
    expect(play.noteState(4)).toBe('miss');
    expect(play.noteState(8)).toBe('pending');

    // Nothing the seek skipped is announced; only the windows the clock closes are.
    play.advance(1000);
    const missed = play.events().filter((event) => event.verdict === 'miss');
    expect(missed.every((event) => event.noteIndex >= 8)).toBe(true);
  });

  test('a note struck ahead of a backward seek is open again', () => {
    const play = engine(scoreOf(2));
    play.start();
    play.advance(BEAT_MS);
    down(play, 60, BEAT_MS);
    expect(play.noteState(1)).toBe('hit');

    play.seek({ measure: 0 });
    expect(play.noteState(1)).toBe('pending');
    expect(play.resolvedAt(1)).toBe(0);
  });

  test('nothing happens during a performance', () => {
    const play = engine(scoreOf(3));
    play.arm();
    play.start();
    play.advance(1000);
    play.seek({ measure: 2 });

    expect(play.snapshot().playedTick).toBe(TICKS_PER_QUARTER);
  });

  test('Wait mode stands at the Onset it lands on', () => {
    const play = engine(scoreOf(3), { mode: 'wait' });
    play.start();
    play.seek({ measure: 1 });

    expect(play.snapshot().stopped).toBe(true);
    expect(play.snapshot().playedTick).toBe(BAR);
  });
});

describe('Section and Loop', () => {
  test('a Section is inert while Loop is off', () => {
    const play = engine(withRepeat());
    play.setSection({ from: 1, to: 1 });

    expect(play.snapshot().playedTick).toBe(0);
    expect(play.walk).toBe(play.score.playOrder);
  });

  test('a Section walks the bars linearly, with no repeat and no jump', () => {
    const score = withRepeat();
    const play = engine(score);
    play.setLoop(true);
    play.setSection({ from: 0, to: 1 });

    expect(play.walk.map((step) => step.tick)).toEqual(score.onsets.map((onset) => onset.tick));
  });

  test('Loop with no Section keeps the piece and its repeats', () => {
    const score = withRepeat();
    const play = engine(score);
    play.setLoop(true);
    play.start();
    // Nine seconds in: the third bar of the play order, which is bar 1 coming round again.
    play.advance(9000);

    expect(play.walk).toBe(score.playOrder);
    expect(where(play).measureIndex).toBe(0);
  });

  test('creating a Section while Idle parks the cursor at its start', () => {
    const play = engine(scoreOf(4));
    play.setLoop(true);
    play.setSection({ from: 2, to: 3 });

    expect(play.snapshot().playedTick).toBe(2 * BAR);
  });

  test('a Section clamped to the piece', () => {
    const play = engine(scoreOf(3));
    play.setSection({ from: 7, to: -2 });

    expect(play.section).toEqual({ from: 0, to: 2 });
  });

  test('the wrap lands on the closing bar line and keeps the rest of the frame', () => {
    const play = engine(scoreOf(3));
    play.setLoop(true);
    play.setSection({ from: 0, to: 1 });
    play.start();
    play.advance(8500);

    // Two bars are eight seconds at 60 BPM: half a second of the ninth is the new lap's.
    expect(play.snapshot().playedTick).toBeCloseTo(TICKS_PER_QUARTER / 2, 6);
  });

  test('the tick jumps on the beat, with no count-in of its own', () => {
    const play = engine(scoreOf(3), { countInBars: 1 });
    play.setLoop(true);
    play.setSection({ from: 1, to: 1 });
    play.start();
    // The count-in of the start, then the one bar of the Section.
    play.advance(4000);
    expect(play.snapshot().playedTick).toBe(BAR);

    play.advance(4000);
    expect(play.snapshot().state).toBe('running');
    expect(play.snapshot().playedTick).toBe(BAR);
    expect(play.countInBeats).toEqual([]);
  });

  test('the first Onset of a new lap misses when nothing is struck', () => {
    const play = engine(scoreOf(3), { countInBars: 1 });
    play.setLoop(true);
    play.setSection({ from: 1, to: 1 });
    play.start();
    // The count-in, the lap that misses its four Onsets, then the wrap.
    play.advance(8000);
    play.events();
    // A quarter of the new lap: long enough for the window of its first Onset to close.
    play.advance(1000);

    expect(play.events().filter((event) => event.verdict === 'miss')).toMatchObject([
      { noteIndex: 4 },
    ]);
    expect(play.noteState(4)).toBe('miss');
  });

  test('a Section skips the repeat its bars carry', () => {
    const play = engine(withRepeat());
    play.setLoop(true);
    play.setSection({ from: 0, to: 1 });
    play.start();
    // Both bars once, then the wrap: the written repeat never plays.
    play.advance(8000);

    expect(play.snapshot().playedTick).toBe(0);
    expect(where(play).measureIndex).toBe(0);
  });

  test('Loop with no Section wraps from the end of the piece to bar one', () => {
    const play = engine(scoreOf(2));
    play.setLoop(true);
    play.start();
    // The end tick is the last written duration plus the matching window at play tempo.
    play.advance(8150);

    expect(play.snapshot().state).toBe('running');
    expect(play.snapshot().playedTick).toBe(0);
  });

  test('a running cursor is never yanked, and Restart goes to the Section start', () => {
    const play = engine(scoreOf(4));
    play.start();
    play.advance(1000);
    play.setSection({ from: 2, to: 3 });
    play.setLoop(true);

    expect(play.snapshot().state).toBe('running');
    expect(play.snapshot().playedTick).toBe(TICKS_PER_QUARTER);

    play.restart();
    expect(play.snapshot().state).toBe('idle');
    expect(play.snapshot().playedTick).toBe(2 * BAR);
  });

  test('Restart with Loop on and no Section keeps the start bar', () => {
    const play = engine(scoreOf(4));
    play.setLoop(true);
    play.seek({ measure: 2 });
    play.start();
    play.advance(1000);
    play.restart();

    expect(play.snapshot().playedTick).toBe(2 * BAR);
  });

  test('Restart goes to the start bar while Loop is off', () => {
    const play = engine(scoreOf(4));
    play.setSection({ from: 2, to: 3 });
    play.start();
    play.advance(1000);
    play.restart();

    expect(play.snapshot().playedTick).toBe(0);
  });

  test('Wait mode asks for every Onset of the Section again on the next lap, whatever is held', () => {
    const play = engine(scoreOf(2), { mode: 'wait' });
    play.setLoop(true);
    play.setSection({ from: 0, to: 0 });
    play.start();
    for (let beat = 0; beat < 4; beat++) {
      play.advance(1000);
      expect(play.snapshot().stopped).toBe(true);
      play.strike({ midi: 60, velocity: 80, time: 0, on: true });
      play.strike({ midi: 60, velocity: 80, time: 0, on: false });
      expect(play.snapshot().stopped).toBe(false);
      // A wrong key goes down in the last beat of the lap and stays down over the wrap.
      if (beat === 3) play.strike({ midi: 61, velocity: 80, time: 0, on: true });
    }
    play.advance(1000);

    expect(play.snapshot().playedTick).toBe(0);
    expect(play.snapshot().stopped).toBe(true);

    // The key held over the wrap names nothing now, so the right key alone frees the cursor.
    play.strike({ midi: 60, velocity: 80, time: 0, on: true });
    expect(play.snapshot().stopped).toBe(false);
  });

  test('a key held through the count-in blocks nothing', () => {
    const play = engine(scoreOf(2), { mode: 'wait', countInBars: 1 });
    play.start();
    // A key goes down during the count-in and stays down into the first bar.
    play.strike({ midi: 61, velocity: 80, time: 0, on: true });
    play.advance(5000);

    expect(play.snapshot().stopped).toBe(true);
    play.strike({ midi: 60, velocity: 80, time: 0, on: true });
    expect(play.snapshot().stopped).toBe(false);
  });

  test('a walk swap keeps the cursor at the written moment it stands on', () => {
    const play = engine(repeatOfBarOne());
    play.start();
    // Into the second pass of bar 1, half a beat past its second Onset.
    play.advance(9500);
    expect(play.snapshot().playedTick).toBe(9120);
    expect(where(play).measureIndex).toBe(0);

    // Loop over a Section swaps the play order for the linear walk under a running cursor.
    play.setSection({ from: 0, to: 1 });
    play.setLoop(true);

    expect(play.snapshot().playedTick).toBe(TICKS_PER_QUARTER + TICKS_PER_QUARTER / 2);
    expect(where(play).measureIndex).toBe(0);
  });

  // A score with no Onset gives an empty walk, so the swap has no written moment to replay onto.
  test('a walk swap over a score with no Onset leaves the clock at the start', () => {
    const play = engine(scoreOf(0));
    play.start();
    play.setSection({ from: 0, to: 0 });
    play.setLoop(true);
    expect(play.snapshot().playedTick).toBe(0);
  });
});
