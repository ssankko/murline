import { Preview, type PreviewSheetView } from '@/preview/preview';
import { fakeRust, type FakeRust } from '@/rust.fake';
import {
  TICKS_PER_QUARTER,
  type Measure,
  type Note,
  type Onset,
  type Score,
} from '@/score/types';
import { beforeEach, expect, test } from 'vitest';

let rust: FakeRust;

beforeEach(() => {
  rust = fakeRust();
});

const BAR = 4 * TICKS_PER_QUARTER;
const PATH = 'bach/praeludium.musicxml';

function note(tick: number): Note {
  return {
    midi: 60,
    staff: 0,
    hand: 'right',
    onsetTick: tick,
    durationTicks: TICKS_PER_QUARTER,
    tiedFrom: false,
    grace: false,
    strikeable: true,
    velocity: 80,
    measureIndex: Math.floor(tick / BAR),
    source: undefined as never,
  };
}

/** Two 4/4 bars at 60 BPM, so a quarter lasts a second, with a quarter note on every beat. */
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
      onsets.push({ tick, measureIndex: bar, notes: [note(tick)] });
    }
  }
  return {
    title: 'Praeludium',
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

/** A sheet that only records what the Preview hands it. */
function fakeSheet(score: Score) {
  const frames: { tick: number; playing: boolean }[] = [];
  const sheet: PreviewSheetView & { frames: typeof frames; disposed: boolean } = {
    score,
    windowTicks: 0,
    seekTo: null,
    spacedTo: null,
    pinching: null,
    frames,
    disposed: false,
    frame: (tick, playing) => void frames.push({ tick, playing }),
    finish() {},
    fit() {},
    setDark() {},
    setLook() {},
    setProportional() {},
    setSpacing() {},
    dispose: () => {
      sheet.disposed = true;
    },
  };
  return sheet;
}

function open(over: { tempoMode?: 'percent' | 'bpm'; tempoValue?: number; reason?: string } = {}) {
  const sheet = fakeSheet(twoBars());
  const preview = new Preview({
    path: PATH,
    sheet,
    tempoMode: over.tempoMode ?? 'percent',
    tempoValue: over.tempoValue ?? 100,
    reason: over.reason ?? '',
  });
  return { sheet, preview };
}

function names(): string[] {
  return rust.calls.map((one) => one.name).filter((name) => name.startsWith('preview_'));
}

/** The event listener registers through a promise, so an emit waits one turn for it. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

test('the first play hands the engine the note list and the rate, the next pauses and resumes', async () => {
  const { preview } = open({ tempoValue: 80 });
  expect(preview.snapshot()).toMatchObject({ title: 'Praeludium', playing: false, tempo: 80 });

  await preview.toggle();
  expect(names()).toEqual(['preview_load', 'preview_rate', 'preview_play']);
  expect(rust.argsOf('preview_load')[0]!['notes']).toHaveLength(8);
  expect(rust.argsOf('preview_rate')[0]).toEqual({ percent: 80 });
  expect(preview.snapshot().playing).toBe(true);

  await preview.toggle();
  expect(names().at(-1)).toBe('preview_pause');
  expect(preview.snapshot().playing).toBe(false);

  await preview.toggle();
  expect(names().filter((name) => name === 'preview_load')).toHaveLength(1);
  expect(names().at(-1)).toBe('preview_play');
});

test('a rewind stops the engine, and the next play loads the piece again', async () => {
  const { preview } = open();
  await preview.toggle();
  preview.rewind();
  expect(names().at(-1)).toBe('preview_stop');
  expect(preview.snapshot().playing).toBe(false);
  expect(preview.seconds()).toBe(0);

  await preview.toggle();
  expect(names().filter((name) => name === 'preview_load')).toHaveLength(2);
});

test('a seek before any play loads the piece, then asks for the second of the target', async () => {
  const { preview } = open();
  await preview.seek({ measure: 1 });
  expect(names()).toEqual(['preview_load', 'preview_rate', 'preview_seek']);
  expect(rust.argsOf('preview_seek')[0]).toEqual({ seconds: 4 });
  // The clock stands on the target at once, before the engine reports back.
  expect(preview.seconds()).toBe(4);

  await preview.seek({ onset: 2 });
  expect(rust.argsOf('preview_seek')[1]).toEqual({ seconds: 2 });
});

test('a tempo change re-sends the rate as a percent and writes the piece row', async () => {
  const { preview, sheet } = open();
  await preview.toggle();
  const band = sheet.windowTicks;

  preview.nudgeTempo(5);
  expect(preview.snapshot().tempo).toBe(105);
  expect(rust.argsOf('preview_rate').at(-1)).toEqual({ percent: 105 });
  expect(rust.argsOf('piece_update_settings')).toEqual([
    { path: PATH, values: { tempo_value: 105 } },
  ]);
  expect(sheet.windowTicks).toBeGreaterThan(band);

  preview.setTempo(50);
  expect(rust.argsOf('preview_rate').at(-1)).toEqual({ percent: 50 });
});

test('a mode switch converts through the written BPM and writes both columns', () => {
  const { preview } = open({ tempoValue: 150 });
  preview.switchMode('bpm');
  expect(preview.snapshot()).toMatchObject({ tempoMode: 'bpm', tempo: 90 });
  expect(rust.argsOf('piece_update_settings')).toEqual([
    { path: PATH, values: { tempo_mode: 'bpm', tempo_value: 90 } },
  ]);

  // The same mode again is no change and writes nothing.
  preview.switchMode('bpm');
  expect(rust.argsOf('piece_update_settings')).toHaveLength(1);
});

test('a progress report moves the clock, and a frame hands the sheet the matching tick', async () => {
  const { preview, sheet } = open();
  await settle();

  rust.emit('previewProgress', { seconds: 3, playing: false });
  preview.frame(performance.now());
  expect(sheet.frames.at(-1)).toEqual({ tick: 3 * TICKS_PER_QUARTER, playing: false });

  // A running clock is carried on at its rate for the time since the report.
  await preview.toggle();
  rust.emit('previewProgress', { seconds: 3, playing: true });
  preview.frame(performance.now() + 1000);
  expect(sheet.frames.at(-1)!.playing).toBe(true);
  expect(sheet.frames.at(-1)!.tick).toBeCloseTo(4 * TICKS_PER_QUARTER, -1);

  // The end of the piece: the time back at zero and nothing playing.
  rust.emit('previewProgress', { seconds: 0, playing: false });
  expect(preview.snapshot().playing).toBe(false);
});

test('with no engine the transport does nothing', async () => {
  const { preview } = open({ reason: 'No instrument chosen' });
  await preview.toggle();
  await preview.seek({ measure: 1 });
  expect(names()).toEqual([]);
  expect(preview.snapshot().playing).toBe(false);
});

test('dispose stops the engine and the sheet', async () => {
  const { preview, sheet } = open();
  await preview.toggle();
  preview.dispose();
  expect(names().at(-1)).toBe('preview_stop');
  expect(sheet.disposed).toBe(true);
});
