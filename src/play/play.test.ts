import { DEFAULT_LANE_LOOK, type LaneLook } from '@/lane/look';
import { Play } from '@/play/play';
import { UNSET_PIECE_SETTINGS, resolvePlaySettings } from '@/play/resolve';
import type { LaneView, SheetView } from '@/play/view';
import { fakeRust, type FakeRust } from '@/rust.fake';
import {
  TICKS_PER_QUARTER,
  type Hand,
  type Measure,
  type Note,
  type Onset,
  type Score,
} from '@/score/types';
import type { Pinch } from '@/sheet/pinch';
import { beforeEach, expect, test } from 'vitest';

let rust: FakeRust;

beforeEach(() => {
  rust = fakeRust();
});

const BAR = 4 * TICKS_PER_QUARTER;
const PATH = 'bach/praeludium.musicxml';

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

/** Both views, writing down every call the Play makes on them in the order they arrive. */
class FakeSheet implements SheetView {
  pinching: Pinch | null = null;
  private readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  open(): void {
    this.log.push('sheet.open');
  }
  frame(): void {
    this.log.push('sheet.frame');
  }
  effect(): void {
    this.log.push('sheet.effect');
  }
  setDark(): void {}
  dispose(): void {
    this.log.push('sheet.dispose');
  }
  finish(): void {
    this.log.push('sheet.finish');
  }
  setLook(): void {}
  setProportional(): void {}
  setSpacing(): void {}
}

class FakeLane implements LaneView {
  look: LaneLook = { ...DEFAULT_LANE_LOOK };
  notice: string | null = null;
  private readonly log: string[];
  constructor(log: string[]) {
    this.log = log;
  }
  open(): void {
    this.log.push('lane.open');
  }
  frame(): void {
    this.log.push('lane.frame');
  }
  effect(): void {
    this.log.push('lane.effect');
  }
  setDark(): void {}
  dispose(): void {
    this.log.push('lane.dispose');
  }
  setRange(): void {
    this.log.push('lane.setRange');
  }
}

/** One play of the two bars, with the inactive hand sounding and the metronome on. */
function playOf(): { play: Play; log: string[]; beats: [boolean, number][] } {
  const log: string[] = [];
  const beats: [boolean, number][] = [];
  const play = new Play({
    path: PATH,
    score: twoBars(),
    resolved: { ...resolvePlaySettings(UNSET_PIECE_SETTINGS), hands: 'right', metronome: true },
    intent: 'practice',
    dark: false,
    sheet: new FakeSheet(log),
    lane: new FakeLane(log),
    host: {} as HTMLElement,
    canvas: {} as HTMLCanvasElement,
  });
  play.set({ inactiveHandSounds: true });
  play.showBeat = (strong, beatMs) => beats.push([strong, beatMs]);
  log.length = 0;
  return { play, log, beats };
}

/** The wall clock a frame runs on, as the screen hands it in. */
const wall = () => performance.now();

test('one frame clicks the beats it crossed, sounds the inactive hand and draws both views', () => {
  const { play, log, beats } = playOf();
  play.toggle();
  rust.calls.length = 0;

  // One second at 60 BPM is one beat: the beat it lands on clicks, and the left hand takes over
  // the note that ends there.
  play.frame(1000, wall());

  // The clicks come before the inactive hand, and both before anything is drawn.
  expect(rust.calls.map((call) => call.name)).toEqual([
    'audio_click',
    'audio_click',
    'audio_note',
    'audio_note',
  ]);
  // The beat the play opens on and the beat it lands on; the icon reads the last of them.
  expect(rust.argsOf('audio_click')).toEqual([
    { strength: 'strong', volume: 70 },
    { strength: 'weak', volume: 70 },
  ]);
  expect(beats).toEqual([[false, 1000]]);
  // The left hand is the inactive one: it sounds the note of each beat at 80 % of its velocity.
  expect(rust.argsOf('audio_note')).toEqual([
    { midi: 48, velocity: 80, on: true, raw: false },
    { midi: 48, velocity: 80, on: true, raw: false },
  ]);
  // Nobody played the right hand's first note, so it closes as a miss both views hear about.
  expect(log).toEqual(['sheet.effect', 'lane.effect', 'sheet.frame', 'lane.frame']);
});

test('the frame that runs off the end fades the sheet and leaves the practice behind', () => {
  const { play, log } = playOf();
  play.toggle();
  rust.calls.length = 0;

  // Both bars in one frame: the clock runs out, which ends the practice where it stands. The
  // whole of that frame counts as motion, the clock having moved through all of it.
  play.frame(9000, wall());

  expect(log[0]).toBe('sheet.finish');
  expect(log.slice(-2)).toEqual(['sheet.frame', 'lane.frame']);
  expect(rust.argsOf('play_insert')).toEqual([
    { path: PATH, kind: 'practice', startedAt: expect.any(Number), durationS: 9 },
  ]);
});

test('leaving stores the place the cursor stood, ahead of the abort that takes it back', async () => {
  const { play, log } = playOf();
  play.toggle();
  play.frame(1000, wall());
  rust.calls.length = 0;
  log.length = 0;

  await play.leave();

  // The tick is the beat the clock stood on, not the start point the abort parks it at.
  expect(rust.argsOf('piece_update_position')).toEqual([{ path: PATH, tick: TICKS_PER_QUARTER }]);
  expect(rust.argsOf('play_insert').length).toBe(1);
  expect(log).toEqual(['sheet.dispose', 'lane.dispose']);
});

test('a Section change gives the Loop its new lap, and a keyboard size re-lays the lane', () => {
  const { play, log } = playOf();
  // With no Section of its own the lap is the whole piece.
  play.set({ loop: true });
  expect(play.loopSpan()!.to).toBeGreaterThan(2 * BAR);

  // The Loop runs the Section's own bar from here, which is the lap the first bar makes.
  play.set({ sectionFrom: 0, sectionTo: 0 });
  expect(play.loopSpan()).toEqual({ from: 0, to: BAR });
  expect(rust.argsOf('piece_update_settings').at(-1)).toEqual({
    path: PATH,
    values: { section_from: 0, section_to: 0 },
  });

  // The keyboard size is global, so it writes no piece column and only the lane answers it.
  log.length = 0;
  play.set({ keyboardPreset: 25 });
  expect(log).toEqual(['lane.setRange']);
  expect(rust.argsOf('piece_update_settings').length).toBe(2);
});
