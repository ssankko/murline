import { INK, colorOf, tone } from '@/look/color';
import { expect, test } from 'vitest';
import { noteheadEl } from './paint';
import { PreviewSheet } from './preview-sheet';

// Vite serves the fixture files as URLs, the closest a browser test gets to the bytes the app
// reads from the library folder.
const FIXTURES = import.meta.glob('../score/fixtures/*', {
  query: '?url',
  import: 'default',
  eager: true,
});

const BACH = 'JohannSebastianBach_PraeludiumInCDur_BWV846_1.xml';
const DYNAMICS = 'dynamics-and-tempo.musicxml';

async function bytesOf(file = BACH): Promise<Uint8Array> {
  const url = FIXTURES[`../score/fixtures/${file}`] as string;
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

function hostEl(width: number): HTMLElement {
  const host = document.createElement('div');
  host.style.cssText = `width:${width}px`;
  document.body.append(host);
  return host;
}

async function open(
  width: number,
  file = BACH,
  dark = false,
): Promise<{ sheet: PreviewSheet; host: HTMLElement }> {
  const host = hostEl(width);
  return { sheet: await PreviewSheet.open(host, await bytesOf(file), file, dark), host };
}

function systemCount(sheet: PreviewSheet): number {
  return sheet.osmd.GraphicSheet.MusicPages.reduce((n, page) => n + page.MusicSystems.length, 0);
}

test('the preview flows the piece down the page in many systems', async () => {
  const { sheet } = await open(600);

  expect(systemCount(sheet)).toBeGreaterThan(1);

  sheet.dispose();
}, 60_000);

test('the title, the subtitle and the composer print on the paper', async () => {
  const { sheet, host } = await open(600);

  const texts = [...host.querySelectorAll('svg text')].map((el) => el.textContent);
  expect(texts).toContain('Praeludium in C-Dur, BWV 846');
  expect(texts).toContain('BWV 846');
  expect(texts).toContain('Johann Sebastian Bach');

  sheet.dispose();
}, 60_000);

test('every notehead carries the pitch colour of its note', async () => {
  const { sheet } = await open(600);

  for (const onset of sheet.score.onsets.slice(0, 8)) {
    for (const note of onset.notes) {
      const head = noteheadEl(sheet.osmd, note.source);
      expect(head?.firstElementChild?.getAttribute('fill')).toBe(colorOf(note.midi, 'muted', false));
    }
  }

  sheet.dispose();
}, 60_000);

test('a wider host re-fits the sheet at a larger zoom', async () => {
  const { sheet, host } = await open(600);
  const narrow = { zoom: sheet.osmd.zoom, width: svgWidth(host) };

  host.style.width = '900px';
  sheet.fit();

  expect(sheet.osmd.zoom).toBeGreaterThan(narrow.zoom);
  expect(svgWidth(host)).toBeGreaterThan(narrow.width);

  sheet.dispose();
}, 60_000);

test('a disposed preview leaves its host empty for the next one', async () => {
  const host = hostEl(600);
  const bytes = await bytesOf();
  const first = await PreviewSheet.open(host, bytes, BACH, false);
  first.dispose();

  expect(host.children.length).toBe(0);

  const second = await PreviewSheet.open(host, bytes, BACH, false);
  expect(host.querySelectorAll('#osmdCanvasPage1').length).toBe(1);
  expect(host.querySelectorAll('svg').length).toBe(1);

  second.dispose();
}, 60_000);

test('a preview opened over one still in flight is the only one left on the paper', async () => {
  const host = hostEl(600);
  const bytes = await bytesOf();
  // What StrictMode does: one host, two opens in flight at once, and the sheet of the mount React
  // threw away is dropped as soon as its open lands.
  const flying = PreviewSheet.open(host, bytes, BACH, false);
  const live = await PreviewSheet.open(host, bytes, BACH, false);
  (await flying).dispose();

  expect(host.querySelectorAll('svg').length).toBe(1);
  expect(host.contains(headOf(live))).toBe(true);

  live.dispose();
}, 60_000);

test('the dark theme reaches the clef and leaves no black ink on the paper', async () => {
  const { sheet, host } = await open(600, DYNAMICS, true);

  expect(host.querySelector('.vf-clef path')?.getAttribute('fill')).toBe(
    tone(INK.scaffolding, true),
  );
  const black = [...host.querySelectorAll('svg *')].filter(
    (el) => el.getAttribute('fill') === '#000000' || el.getAttribute('stroke') === '#000000',
  );
  expect(black.map((el) => `${el.tagName} in ${el.parentElement?.getAttribute('class')}`)).toEqual(
    [],
  );

  sheet.setDark(false);
  expect(host.querySelector('.vf-clef path')?.getAttribute('fill')).toBe(
    tone(INK.scaffolding, false),
  );

  sheet.dispose();
}, 60_000);

test('a dynamic written as SMuFL glyph names prints as its letters', async () => {
  const { sheet, host } = await open(600, DYNAMICS);

  const texts = [...host.querySelectorAll('svg text')].map((el) => el.textContent);
  expect(texts).toContain('mf');
  expect(texts.filter((text) => text?.includes('sym'))).toEqual([]);

  sheet.dispose();
}, 60_000);

/** A notehead of the sheet's first Onset: which host it hangs in says which render is on screen. */
function headOf(sheet: PreviewSheet): HTMLElement {
  return noteheadEl(sheet.osmd, sheet.score.onsets[0]!.notes[0]!.source)!;
}

function svgWidth(host: HTMLElement): number {
  return Number(host.querySelector('svg')?.getAttribute('width'));
}
