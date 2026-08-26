import { colorOf } from '@/look/color';
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

async function open(width: number): Promise<{ sheet: PreviewSheet; host: HTMLElement }> {
  const url = FIXTURES[`../score/fixtures/${BACH}`] as string;
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
  const host = document.createElement('div');
  host.style.cssText = `width:${width}px`;
  document.body.append(host);
  return { sheet: await PreviewSheet.open(host, bytes, BACH, false), host };
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

function svgWidth(host: HTMLElement): number {
  return Number(host.querySelector('svg')?.getAttribute('width'));
}
