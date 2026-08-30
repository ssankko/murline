import { Engine } from '@/play/engine';
import { Ghosts } from '@/play/ghost';
import { DEFAULT_PLAY_SETTINGS, type PlaySettings } from '@/play/settings';
import {
  TICKS_PER_QUARTER,
  type Hand,
  type Measure,
  type Note,
  type Onset,
  type Score,
} from '@/score/types';
import { fakeRust, type FakeRust } from '@/rust.fake';
import { beforeEach, expect, test } from 'vitest';

let rust: FakeRust;
let ghosts: Ghosts;

beforeEach(() => {
  ghosts = new Ghosts();
  rust = fakeRust();
});

const BAR = 4 * TICKS_PER_QUARTER;

function note(midi: number, hand: Hand, tick: number, velocity: number): Note {
  return {
    midi,
    staff: hand === 'right' ? 0 : 1,
    hand,
    onsetTick: tick,
    durationTicks: TICKS_PER_QUARTER,
    tiedFrom: false,
    grace: false,
    strikeable: true,
    velocity,
    measureIndex: Math.floor(tick / BAR),
    source: undefined as never,
  };
}

/**
 * Two 4/4 bars at 60 BPM, so a quarter lasts a second, with a quarter note on every beat in each
 * hand: C4 in the right at velocity 80, C3 in the left at velocity 100.
 */
function twoBars(): Score {
  const measures: Measure[] = [];
  const onsets: Onset[] = [];
  for (let bar = 0; bar < 2; bar++) {
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
        notes: [note(60, 'right', tick, 80), note(48, 'left', tick, 100)],
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
    totalTicks: 2 * BAR,
    tempoMap: [{ tick: 0, bpm: 60 }],
    hasTempo: true,
    constantTempo: true,
    hasDynamics: true,
    measures,
    keys: [],
    chords: [],
    harmony: [],
  };
}

function engine(settings: Partial<PlaySettings> = {}) {
  return new Engine(twoBars(), {
    ...DEFAULT_PLAY_SETTINGS,
    countInBars: 0,
    hands: 'right',
    inactiveHandSounds: true,
    ...settings,
  });
}

test('the left hand is owed on and off at its own ticks, at its written velocity', () => {
  const play = engine();
  play.start();

  // Half way through the first beat: the left hand sounds, the right hand the player is playing
  // does not.
  play.advance(500);
  expect(play.ghosts()).toEqual([{ midi: 48, velocity: 100, on: true }]);

  // On the second beat the first note has run out and the second starts, in that order.
  play.advance(500);
  expect(play.ghosts()).toEqual([
    { midi: 48, velocity: 0, on: false },
    { midi: 48, velocity: 100, on: true },
  ]);
});

test('a seek lets go of what the left hand is sounding', () => {
  const play = engine();
  play.start();
  play.advance(500);
  play.ghosts();

  play.seek({ measure: 1 });
  expect(play.ghosts()).toEqual([{ midi: 48, velocity: 0, on: false }]);
});

test('a pause lets go of what the left hand is sounding', () => {
  const play = engine();
  play.start();
  play.advance(500);
  play.ghosts();

  play.pause();
  expect(play.ghosts()).toEqual([{ midi: 48, velocity: 0, on: false }]);
});

test('hands on both owes nothing, whatever the setting says', () => {
  const play = engine({ hands: 'both' });
  play.start();

  play.advance(2000);
  expect(play.ghosts()).toEqual([]);
});

test('the setting off owes nothing, and turning it on starts from where the clock stands', () => {
  const play = engine({ inactiveHandSounds: false });
  play.start();

  play.advance(2500);
  expect(play.ghosts()).toEqual([]);

  // The notes already passed stay silent: only the note the clock reaches next sounds.
  play.settings.inactiveHandSounds = true;
  play.advance(500);
  expect(play.ghosts()).toEqual([{ midi: 48, velocity: 100, on: true }]);
});

/** The two Playing settings, over the defaults, as the Play hands them to the ghosts. */
function sounding(velocity: 'score' | 'follow', level: number): PlaySettings {
  return { ...DEFAULT_PLAY_SETTINGS, inactiveHandVelocity: velocity, inactiveHandLevel: level };
}

test('each owed note is one call of the note command, and a silence lets go of what is down', () => {
  const settings = sounding('score', 100);
  ghosts.note({ midi: 48, velocity: 80, on: true }, settings);
  ghosts.note({ midi: 50, velocity: 64, on: true }, settings);
  ghosts.note({ midi: 48, velocity: 0, on: false }, settings);
  ghosts.silence();

  expect(rust.argsOf('audio_note')).toEqual([
    { midi: 48, velocity: 80, on: true, raw: false },
    { midi: 50, velocity: 64, on: true, raw: false },
    { midi: 48, velocity: 0, on: false, raw: false },
    { midi: 50, velocity: 0, on: false, raw: false },
  ]);
});

/** The velocity of the one note the calls hold, and whether the velocity curve was kept off it. */
function sent(): { velocity: number; raw: boolean } {
  const { velocity, raw } = rust.argsOf('audio_note').at(-1)!;
  return { velocity, raw };
}

test('from the score plays the written velocity at the level, through the velocity curve', () => {
  ghosts.note({ midi: 48, velocity: 80, on: true }, sounding('score', 80));
  expect(sent()).toEqual({ velocity: 64, raw: false });
});

test('the strikes the player makes are what follow plays at, and they are not remapped again', () => {
  for (const velocity of [40, 40, 40]) ghosts.strike(velocity);
  ghosts.note({ midi: 48, velocity: 100, on: true }, sounding('follow', 100));
  expect(sent()).toEqual({ velocity: 40, raw: true });
});

test('follow before the first strike plays the written velocity, through the velocity curve', () => {
  ghosts.note({ midi: 48, velocity: 100, on: true }, sounding('follow', 50));
  expect(sent()).toEqual({ velocity: 50, raw: false });
});

test('a silence forgets the strikes, so the next play follows its own', () => {
  ghosts.strike(40);
  ghosts.silence();
  ghosts.note({ midi: 48, velocity: 100, on: true }, sounding('follow', 100));
  expect(sent()).toEqual({ velocity: 100, raw: false });
});
