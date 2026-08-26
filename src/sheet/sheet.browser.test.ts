import { INK, colorOf, tone } from '@/look/color';
import type { Snapshot } from '@/play/engine';
import { expect, test } from 'vitest';
import { noteheadEl } from './paint';
import { Sheet } from './sheet';

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

test('the inactive hand drops to the scaffolding tier and the active hand keeps its colour', async () => {
  const sheet = await open();
  const notes = sheet.score.onsets.flatMap((onset) => onset.notes);
  const right = notes.find((note) => note.hand === 'right')!;
  const left = notes.find((note) => note.hand === 'left')!;

  sheet.setHands('left');
  const fill = (note: typeof right) =>
    noteheadEl(sheet.osmd, note.source)?.firstElementChild?.getAttribute('fill');
  expect(fill(right)).toBe(tone(INK.scaffolding, false));
  expect(fill(left)).toBe(colorOf(left.midi, 'muted', false));

  sheet.setHands('both');
  expect(fill(right)).toBe(colorOf(right.midi, 'muted', false));

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

test('a chord bubble stands over every chord event and dims once the cursor is past', async () => {
  const sheet = await open();
  const events = sheet.score.harmony;
  // The host of the sheet just opened, so a sheet left behind by another test cannot be read here.
  const host = document.body.lastElementChild!;
  const bubbles = [...host.querySelectorAll<HTMLElement>('.chord-bubble')];

  expect(events.length).toBe(33);
  expect(bubbles.length).toBe(events.length);
  expect(bubbles[0]!.textContent).toBe('C1');
  expect(bubbles[0]!.querySelector('i')?.textContent).toBe('1');

  // CSS keeps six significant digits, so a place far along the line reads back a little rounded.
  const lefts = bubbles.map((el) => parseFloat(el.style.left));
  for (let i = 0; i < events.length; i++) {
    expect(Math.abs(lefts[i]! - sheet.xOfOnset(events[i]!.onsetIndex))).toBeLessThan(0.1);
    if (i > 0) expect(lefts[i]).toBeGreaterThan(lefts[i - 1]!);
  }

  // Halfway from the third chord's Onset to the fourth's: three chords are behind the cursor.
  const tickOf = (onsetIndex: number) =>
    sheet.score.playOrder.find((step) => step.onsetIndex === onsetIndex)!.tick;
  const at = (tickOf(events[2]!.onsetIndex) + tickOf(events[3]!.onsetIndex)) / 2;
  sheet.frame(snapshot(at), 100, 0);

  expect(bubbles.filter((el) => el.classList.contains('past')).length).toBe(3);
  for (const el of bubbles.slice(0, 3)) expect(el.classList.contains('past')).toBe(true);

  sheet.dispose();
}, 60_000);

function snapshot(playedTick: number): Snapshot {
  return {
    state: 'running',
    kind: 'practice',
    playedTick,
    stepIndex: 0,
    onsetIndex: 0,
    measureIndex: 0,
  };
}
