import { describe, expect, test } from 'vitest';
import { buildScore } from './build';
import { loadSheet } from './load';
import { summarize } from './summarize';
import { ScoreError, TICKS_PER_QUARTER, type Score } from './types';

// Vite serves the fixture files as URLs, which is the closest a browser test gets to the bytes the
// app reads from the library folder.
const FIXTURES = import.meta.glob('./fixtures/*', { query: '?url', import: 'default', eager: true });

async function score(fileName: string): Promise<Score> {
  const url = FIXTURES[`./fixtures/${fileName}`] as string;
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return buildScore((await loadSheet(bytes, fileName)).Sheet);
}

/** A backward jump is a step whose played time runs on while its sheet time goes back. */
function backwardJumps(built: Score): number {
  let jumps = 0;
  for (let i = 1; i < built.playOrder.length; i++) {
    const before = built.onsets[built.playOrder[i - 1]!.onsetIndex]!.tick;
    const after = built.onsets[built.playOrder[i]!.onsetIndex]!.tick;
    if (after < before) jumps++;
  }
  return jumps;
}

// Steps and Onsets per fixture. The Score keeps the first part only and drops the moments where it
// rests, so a file that splits the hands into two parts counts fewer of both than a walk of every
// container does: Clementi 518/259, Joplin 981/588 and Schumann 192/144 over all parts and rests.
describe('the walk of the OSMD corpus', () => {
  const cases: [string, number, number, number][] = [
    ['MuzioClementi_SonatinaOpus36No1_Part1.xml', 444, 222, 2],
    ['ScottJoplin_The_Entertainer.xml', 904, 538, 4],
    ['Schumann_The_Wild_Horseman_Op._68_No._8.mxl', 184, 138, 1],
    ['test_repeat_volta_simple.musicxml', 4, 3, 1],
    ['JohannSebastianBach_PraeludiumInCDur_BWV846_1.xml', 545, 545, 0],
  ];

  test.each(cases)('%s walks %i steps over %i Onsets with %i jumps', async (file, steps, onsets, jumps) => {
    const built = await score(file);
    expect(built.playOrder.length).toBe(steps);
    expect(built.onsets.length).toBe(onsets);
    expect(backwardJumps(built)).toBe(jumps);
  });
});

describe('the Score of a piece', () => {
  test('Bach BWV 846 reads as one part in C major with no tempo of its own', async () => {
    const built = await score('JohannSebastianBach_PraeludiumInCDur_BWV846_1.xml');
    expect(built.partCount).toBe(1);
    expect(built.staffCount).toBe(2);
    expect(built.keys).toEqual([{ measureIndex: 0, sharps: 0, mode: 0 }]);
    expect(built.measures.length).toBe(35);
    expect(built.measures[0]).toMatchObject({
      number: 1,
      startTick: 0,
      durationTicks: 4 * TICKS_PER_QUARTER,
      beatsPerBar: 4,
      beatUnit: 4,
    });
    expect(built.totalTicks).toBe(35 * 4 * TICKS_PER_QUARTER);
    expect(built.chords).toEqual([]);
  });

  test('every note of a two-staff part carries a hand and a sounding length', async () => {
    const built = await score('JohannSebastianBach_PraeludiumInCDur_BWV846_1.xml');
    const notes = built.onsets.flatMap((o) => o.notes);
    expect(notes.every((n) => n.hand === (n.staff === 0 ? 'right' : 'left'))).toBe(true);
    expect(notes.every((n) => n.midi >= 21 && n.midi <= 108)).toBe(true);
    expect(notes.every((n) => n.strikeable === !n.tiedFrom)).toBe(true);
    // The prelude ties its bass and tenor across each bar line, so a chain sounds a whole bar
    // while every written note of the piece is a sixteenth or a quarter.
    expect(notes.some((n) => n.tiedFrom)).toBe(true);
    expect(Math.max(...notes.map((n) => n.durationTicks))).toBe(4 * TICKS_PER_QUARTER);
  });

  test('a repeat replays the same Onsets at later played ticks', async () => {
    const built = await score('test_repeat_volta_simple.musicxml');
    expect(built.playOrder.map((s) => s.onsetIndex)).toEqual([0, 1, 0, 2]);
    expect(built.playOrder.map((s) => s.tick)).toEqual([0, 1920, 3840, 5760]);
  });

  test('a file with no tempo mark gets the first measure tempo and no tempo of its own', async () => {
    const built = await score('test_repeat_volta_simple.musicxml');
    expect(built.hasTempo).toBe(false);
    expect(built.tempoMap).toEqual([{ tick: 0, bpm: 120 }]);
  });
});

describe('tempo and dynamics on a MuseScore 4 export', () => {
  const FILE = 'dynamics-and-tempo.musicxml';

  test('the tempo map holds the metronome mark and the later change', async () => {
    const built = await score(FILE);
    expect(built.hasTempo).toBe(true);
    expect(built.constantTempo).toBe(false);
    expect(built.tempoMap).toEqual([
      { tick: 0, bpm: 96 },
      { tick: 16 * TICKS_PER_QUARTER, bpm: 72 },
    ]);
  });

  test('ideal velocity follows the last mark on the same staff', async () => {
    const built = await score(FILE);
    const at = (bar: number, staff: number) =>
      built.onsets
        .flatMap((o) => o.notes)
        .filter((n) => n.measureIndex === bar - 1 && n.staff === staff)
        .map((n) => n.velocity);
    expect(at(1, 0)).toEqual([49, 49, 49, 49]);
    expect(at(4, 0)).toEqual([49, 49, 49, 49]);
    expect(at(5, 0)).toEqual([96, 96, 96, 96]);
    expect(at(1, 1)).toEqual([64, 64]);
    expect(at(8, 1)).toEqual([64, 64]);
    expect(built.hasDynamics).toBe(true);
  });

  test('a score without a dynamics mark gives every note the middle velocity', async () => {
    const built = await score('JohannSebastianBach_PraeludiumInCDur_BWV846_1.xml');
    expect(built.onsets.flatMap((o) => o.notes).every((n) => n.velocity === 80)).toBe(true);
    expect(built.hasDynamics).toBe(false);
  });
});

describe('the index', () => {
  test('summarize reports the facts the library page shows', async () => {
    const built = await score('MuzioClementi_SonatinaOpus36No1_Part1.xml');
    const index = summarize(built, 'MuzioClementi_SonatinaOpus36No1_Part1.xml');
    expect(index).toMatchObject({
      title: 'Sonatina Op.36 No 1 Teil 1 Allegro',
      composer: 'Muzio Clementi',
      measureCount: 38,
      // The file splits the hands into two parts and the Score plays the first one, so the range
      // and the parts line are the right hand's.
      midiLo: 55,
      midiHi: 86,
      keySharps: 0,
      keyMode: 'major',
      partCount: 2,
      partName: 'Piano (right)',
    });
    expect(index.durationS).toBeGreaterThan(60);
    expect(index.durationS).toBeLessThan(180);
  });

  test('a compressed file indexes like any other', async () => {
    const file = 'Schumann_The_Wild_Horseman_Op._68_No._8.mxl';
    const index = summarize(await score(file), file);
    expect(index.title).toBe('The Wild Horseman');
    expect(index.measureCount).toBeGreaterThan(0);
  });
});

describe('a sheet with nothing to play', () => {
  test('a sheet with no part carries the same reason as a sheet with no note', () => {
    const sheet = { Instruments: [] } as unknown as Parameters<typeof buildScore>[0];
    expect(() => buildScore(sheet)).toThrow(ScoreError);
    expect(() => buildScore(sheet)).toThrow('No notes in the first part');
  });
});

describe('a file that names a chord before it names a key', () => {
  test('the chord symbol reads against C major', async () => {
    const built = await score('harmony-no-key.musicxml');
    expect(built.chords).toMatchObject([{ tick: 0, measureIndex: 0, text: 'G7' }]);
  });
});
