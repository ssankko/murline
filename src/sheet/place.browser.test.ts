import { buildScore } from '@/score/build';
import { loadInto } from '@/score/load';
import { TICKS_PER_QUARTER, type Score } from '@/score/types';
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { expect, test } from 'vitest';
import { bandWidth, hitAt, place, systemsOf } from './place';

// Vite serves the fixture files as URLs, the closest a browser test gets to the bytes the app
// reads from the library folder.
const FIXTURES = import.meta.glob('../score/fixtures/*', {
  query: '?url',
  import: 'default',
  eager: true,
});

const BACH = 'JohannSebastianBach_PraeludiumInCDur_BWV846_1.xml';
/** Two bars whose rests leave the opening beat of bar 1 and the second beat of bar 2 silent. */
const RESTS = 'rest-then-notes.musicxml';

async function bytesOf(file: string): Promise<Uint8Array> {
  const url = FIXTURES[`../score/fixtures/${file}`] as string;
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

/** A piece rendered as a page of systems, the way the Preview draws it, with its Score. */
async function page(file: string): Promise<{ osmd: OpenSheetMusicDisplay; score: Score }> {
  const host = document.createElement('div');
  host.style.cssText = 'width:1000px';
  document.body.append(host);
  const osmd = new OpenSheetMusicDisplay(host, {
    backend: 'svg',
    autoResize: false,
    pageFormat: 'Endless',
  });
  await loadInto(osmd, await bytesOf(file), file);
  osmd.render();
  return { osmd, score: buildScore(osmd.Sheet) };
}

test('every Onset is placed in its bar and on its system, the systems in reading order', async () => {
  const { osmd, score } = await page(BACH);
  const at = place(osmd, score, false);
  const systems = systemsOf(osmd);

  expect(systems.length).toBeGreaterThan(1);
  expect(at.placed.length).toBe(score.onsets.length);
  for (const [i, onset] of score.onsets.entries()) {
    const where = at.placed[i]!;
    const box = at.boxes[onset.measureIndex]!;
    expect(where.x).toBeGreaterThanOrEqual(box.left);
    expect(where.x).toBeLessThanOrEqual(where.measureRight);
    expect(where.measureRight).toBe(box.right);
    if (i > 0) expect(where.system).toBeGreaterThanOrEqual(at.placed[i - 1]!.system);
  }
  expect(at.placed[at.placed.length - 1]!.system).toBe(systems.length - 1);
  // Spaced by its engraving, the sheet has no one pixels per tick.
  expect(at.pxPerTick).toBe(0);
  expect(bandWidth(100, 0)).toBe(2);
  expect(bandWidth(100, 0.5)).toBe(100);

  osmd.clear();
}, 60_000);

test('a hit test on a page measures only the moments of the system asked for', async () => {
  const { osmd, score } = await page(BACH);
  const at = place(osmd, score, false);
  const second = at.placed.findIndex((where) => where.system === 1);
  const x = at.placed[second]!.x;

  // The same x names one Onset on the second system and another on the third.
  expect(hitAt(x, score.onsets, at, 1)).toEqual({
    seek: { onset: second },
    measure: score.onsets[second]!.measureIndex,
  });
  const third = hitAt(x, score.onsets, at, 2)!;
  expect('onset' in third.seek && at.placed[third.seek.onset]!.system).toBe(2);

  // Past the last system there is nothing to hit; with no system every Onset is a candidate.
  expect(hitAt(x, score.onsets, at, systemsOf(osmd).length)).toBe(null);
  expect(hitAt(at.placed[0]!.x, score.onsets, at)).toEqual({ seek: { onset: 0 }, measure: 0 });

  osmd.clear();
}, 60_000);

test('a hit on a rest seeks to its place in the bar, and past a bar line into the next bar', async () => {
  const { osmd, score } = await page(RESTS);
  const at = place(osmd, score, false);
  const onsets = score.onsets;

  // Bar 1 opens with a quarter rest, so the leftmost moment of the sheet is no Onset at all.
  expect(onsets[0]!.tick).toBe(TICKS_PER_QUARTER);
  expect(hitAt(0, onsets, at)).toEqual({ seek: { measure: 0, into: 0 }, measure: 0 });

  // The rest on the second beat of bar 2 stands between the two noteheads that surround it.
  const before = onsets.findIndex((onset) => onset.tick === 4 * TICKS_PER_QUARTER);
  const after = before + 1;
  const middle = (at.placed[before]!.x + at.placed[after]!.x) / 2;
  expect(hitAt(middle, onsets, at)).toEqual({
    seek: { measure: 1, into: TICKS_PER_QUARTER },
    measure: 1,
  });
  expect(hitAt(at.placed[after]!.x, onsets, at)).toEqual({ seek: { onset: after }, measure: 1 });

  // A click past the bar line of bar 1, nearer its last Onset than to bar 2's first, still fell
  // in bar 2.
  const last = onsets.findLastIndex((onset) => onset.measureIndex === 0);
  const over = at.placed[last]!.measureRight + 1;
  const hit = hitAt(over, onsets, at)!;
  expect(hit.measure).toBe(1);

  osmd.clear();
}, 60_000);
