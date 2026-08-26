import { colorOf } from '@/look/color';
import { expect, test } from 'vitest';
import { Sheet, noteheadEl } from './sheet';

// Vite serves the fixture files as URLs, the closest a browser test gets to the bytes the app
// reads from the library folder.
const FIXTURES = import.meta.glob('../score/fixtures/*', {
  query: '?url',
  import: 'default',
  eager: true,
});

const BACH = 'JohannSebastianBach_PraeludiumInCDur_BWV846_1.xml';
const VOLTA = 'test_repeat_volta_simple.musicxml';

async function open(file = BACH): Promise<Sheet> {
  const url = FIXTURES[`../score/fixtures/${file}`] as string;
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const host = document.createElement('div');
  host.style.cssText = 'width:900px;height:220px';
  document.body.append(host);
  return Sheet.open(host, bytes, file, false);
}

test('the sheet renders the piece on one horizontal line', async () => {
  const sheet = await open();

  const systems = sheet.osmd.GraphicSheet.MusicPages.flatMap((page) => page.MusicSystems);
  expect(systems.length).toBe(1);
  expect(sheet.score.onsets.length).toBe(545);

  sheet.dispose();
}, 60_000);

test('every notehead carries the pitch colour of its note', async () => {
  const sheet = await open();

  for (const onset of sheet.score.onsets.slice(0, 8)) {
    for (const note of onset.notes) {
      const head = noteheadEl(sheet.osmd, note.source);
      expect(head?.firstElementChild?.getAttribute('fill')).toBe(colorOf(note.midi, 'muted', false));
    }
  }
  // The C of the first chord, in the palette's red, and its E in yellow-green.
  expect(colorOf(60, 'muted', false)).toBe('#cc3b33');
  expect(colorOf(64, 'muted', false)).toBe('#adcc33');

  sheet.dispose();
}, 60_000);

test('Onsets are placed left to right along the line', async () => {
  const sheet = await open();

  const xs = sheet.score.onsets.slice(0, 12).map((_, i) => sheet.xOfOnset(i));
  expect(xs[0]).toBeGreaterThan(0);
  for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]!);

  sheet.dispose();
}, 60_000);

test('the cursor slides from one Onset to the next', async () => {
  const sheet = await open();

  const [first, second] = sheet.score.playOrder;
  const middle = (first!.tick + second!.tick) / 2;
  const at = sheet.cursorAt(middle, 0, 100);

  expect(at.onsetIndex).toBe(0);
  expect(at.x).toBeGreaterThan(sheet.xOfOnset(0));
  expect(at.x).toBeLessThan(sheet.xOfOnset(1));

  sheet.dispose();
}, 60_000);

test('before a backward jump the cursor runs on to the bar line instead of sliding back', async () => {
  const sheet = await open(VOLTA);

  const order = sheet.score.playOrder;
  const jump = order.findIndex(
    (step, i) =>
      !!order[i + 1] &&
      sheet.score.onsets[order[i + 1]!.onsetIndex]!.tick < sheet.score.onsets[step.onsetIndex]!.tick,
  );
  expect(jump).toBeGreaterThanOrEqual(0);

  const from = sheet.xOfOnset(order[jump]!.onsetIndex);
  const back = sheet.xOfOnset(order[jump + 1]!.onsetIndex);
  const nearly = order[jump]!.tick + (order[jump + 1]!.tick - order[jump]!.tick) * 0.9;

  expect(back).toBeLessThan(from);
  expect(sheet.cursorAt(nearly, jump, 100).x).toBeGreaterThan(from);

  sheet.dispose();
}, 60_000);
