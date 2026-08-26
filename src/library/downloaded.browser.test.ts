import { indexBytes } from '@/library/index-file';
import { expect, test } from 'vitest';

// What each provider hands the import path: the KernScores merge's output, and the one `.xml`
// taken out of a PDMX `.mxl`. Both must index as a single playable part.
const KERNSCORES = new URL('../score/fixtures/kernscores-mazurka-50.musicxml', import.meta.url).href;
const PDMX = new URL('../score/fixtures/pdmx-score.xml', import.meta.url).href;

async function index(url: string) {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  return indexBytes(bytes, url.split('/').pop()!);
}

test('a merged KernScores download indexes as one part', async () => {
  const piece = await index(KERNSCORES);
  expect(piece.partCount).toBe(1);
  expect(piece.measureCount).toBeGreaterThan(0);
});

test('the MusicXML inside a PDMX .mxl indexes as one part', async () => {
  const piece = await index(PDMX);
  expect(piece.partCount).toBe(1);
  expect(piece.measureCount).toBeGreaterThan(0);
});
