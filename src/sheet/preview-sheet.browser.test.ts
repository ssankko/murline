import { INK, colorOf, tone } from '@/look/color';
import type { SeekTarget } from '@/play/engine';
import { TICKS_PER_QUARTER } from '@/score/types';
import { expect, test } from 'vitest';
import { noteheadEl } from './paint';
import { systemsOf } from './place';
import { PreviewSheet } from './preview-sheet';
import { DETACH_MS, SCROLL_GLIDE_MS } from './sheet';

// Vite serves the fixture files as URLs, the closest a browser test gets to the bytes the app
// reads from the library folder.
const FIXTURES = import.meta.glob('../score/fixtures/*', {
  query: '?url',
  import: 'default',
  eager: true,
});

const BACH = 'JohannSebastianBach_PraeludiumInCDur_BWV846_1.xml';
const DYNAMICS = 'dynamics-and-tempo.musicxml';
/** Two bars whose rests leave the opening beat of bar 1 and the second beat of bar 2 silent. */
const RESTS = 'rest-then-notes.musicxml';

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

test('both margins are the same on every system, and no part name prints', async () => {
  const { sheet, host } = await open(1000);
  const width = svgWidth(host);
  const systems = systemBoxes(sheet);
  expect(systems.length).toBeGreaterThan(2);

  // Staff lines are the level paths VexFlow draws across a bar; a system's are the ones inside it.
  const lines = [...host.querySelectorAll<SVGGraphicsElement>('svg .vf-measure path')]
    .map((el) => el.getBBox())
    .filter((box) => box.height < 1 && box.width > 100);
  const margins = systems.map((system) => {
    const mine = lines.filter((box) => box.y >= system.top && box.y <= system.bottom);
    expect(mine.length).toBeGreaterThan(0);
    const left = Math.min(...mine.map((box) => box.x));
    return { left, right: width - Math.max(...mine.map((box) => box.x + box.width)) };
  });
  // The last system holds what is left of the piece, and OSMD stretches it only so far.
  for (const { left, right } of margins.slice(0, -1)) {
    expect(left).toBeCloseTo(50, 0);
    expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  }
  expect(margins[margins.length - 1]!.left).toBeCloseTo(50, 0);
  const texts = [...host.querySelectorAll('svg text')].map((el) => el.textContent ?? '');
  expect(texts.filter((text) => /piano|pno/i.test(text))).toEqual([]);

  sheet.dispose();
}, 60_000);

test('the band stands at the Onset the tick names, glides within a system, snaps across', async () => {
  const { sheet, host } = await open(1000);
  const cursor = host.querySelector<HTMLElement>('.sheet-cursor')!;
  const systems = systemBoxes(sheet);
  const onsets = sheet.score.onsets;
  const tickOf = (onsetIndex: number) =>
    sheet.score.playOrder.find((step) => step.onsetIndex === onsetIndex)!.tick;

  // Opened, the band already stands on the first Onset, over the whole first system.
  expect(bandX(cursor)).toBeCloseTo(sheet.xOfOnset(0), 1);
  expect(parseFloat(cursor.style.top)).toBeCloseTo(systems[0]!.top, 1);
  expect(parseFloat(cursor.style.height)).toBeCloseTo(systems[0]!.bottom - systems[0]!.top, 1);

  // Before the first Onset the band stands on it, not left of it.
  sheet.frame(-TICKS_PER_QUARTER, false, 0);
  expect(bandX(cursor)).toBeCloseTo(sheet.xOfOnset(0), 1);

  // A seek to a later Onset of the same system glides; halfway between two it stands between them.
  const placed = onsets.map((_, i) => sheet.xOfOnset(i));
  const second = placed.findIndex((_, i) => i > 0 && placed[i]! < placed[i - 1]!);
  sheet.frame(tickOf(3), false, 16);
  expect(bandX(cursor)).toBeCloseTo(placed[3]!, 1);
  expect(cursor.style.transition).toContain('transform');
  sheet.frame((tickOf(3) + tickOf(4)) / 2, false, 32);
  expect(bandX(cursor)).toBeCloseTo((placed[3]! + placed[4]!) / 2, 1);

  // The first Onset of the second system: the band snaps there, on that system.
  sheet.frame(tickOf(second), false, 48);
  expect(bandX(cursor)).toBeCloseTo(placed[second]!, 1);
  expect(cursor.style.transition).toBe('none');
  expect(parseFloat(cursor.style.top)).toBeCloseTo(systems[1]!.top, 1);

  // The heads of the Onset the band stands on wear the ring; the ones it left do not.
  const ringed = (i: number) =>
    noteheadEl(sheet.osmd, onsets[i]!.notes[0]!.source)!.firstElementChild!.getAttribute('stroke');
  expect(ringed(second)).toBe('#ffffff');
  expect(ringed(3)).not.toBe('#ffffff');

  sheet.dispose();
}, 60_000);

test('a click on a rest seeks into its bar, and on a notehead to its Onset', async () => {
  const { sheet, host } = await open(1000, RESTS);
  const hits: SeekTarget[] = [];
  sheet.onSeek = (target) => hits.push(target);
  const onsets = sheet.score.onsets;
  const head = noteheadEl(sheet.osmd, onsets[2]!.notes[0]!.source)!.getBoundingClientRect();
  const click = (clientX: number, clientY: number) =>
    host
      .querySelector('svg')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }));

  // Bar 1 opens with a quarter rest: the left edge of the system is that rest's moment.
  expect(onsets[0]!.tick).toBe(TICKS_PER_QUARTER);
  click(host.getBoundingClientRect().left, head.y + head.height / 2);
  expect(hits).toEqual([{ measure: 0, into: 0 }]);

  click(head.x + head.width / 2, head.y + head.height / 2);
  expect(hits[1]).toEqual({ onset: 2 });

  sheet.dispose();
}, 60_000);

test('spacing at 300 widens a bar, and the strip prints only while harmony is on', async () => {
  const { sheet, host } = await open(1000);
  const barWidth = () => {
    const box = sheet.osmd.GraphicSheet.MeasureList[1]![0]!.PositionAndShape;
    return box.BorderRight - box.BorderLeft;
  };
  const gap = () => {
    const [first, second] = systemBoxes(sheet);
    return second!.top - first!.bottom;
  };
  const bubbles = () => host.querySelectorAll<HTMLElement>('.chord-bubble');
  const engraved = barWidth();
  const roomy = gap();

  expect(bubbles().length).toBe(sheet.score.harmony.length);
  expect(sheet.score.harmony.length).toBeGreaterThan(0);
  // Each bubble stands above its own system's top staff line, under the system before it.
  const systems = systemBoxes(sheet);
  sheet.score.harmony.forEach((event, i) => {
    const top = parseFloat(bubbles()[i]!.style.top);
    const system = systems.findIndex((box) => top < box.staffline && top > box.staffline - 29);
    expect(system).toBeGreaterThanOrEqual(0);
    expect(bubbles()[i]!.textContent).toContain(event.absolute);
    if (system > 0) expect(top).toBeGreaterThanOrEqual(systems[system - 1]!.bottom);
  });

  sheet.setLook({ harmony: false });
  expect(bubbles().length).toBe(0);
  expect(gap()).toBeLessThan(roomy);

  sheet.setProportional(true);
  sheet.setSpacing(300);
  expect(barWidth()).toBeGreaterThan(engraved * 1.5);

  sheet.setLook({ harmony: true });
  expect(bubbles().length).toBe(sheet.score.harmony.length);

  sheet.dispose();
}, 60_000);

test('while playing the page follows the band down, and gives way to a hand scroll', async () => {
  const scroller = document.createElement('div');
  scroller.style.cssText = 'width:1000px;height:600px;overflow-y:auto';
  document.body.append(scroller);
  const host = document.createElement('div');
  scroller.append(host);
  const sheet = await PreviewSheet.open(host, await bytesOf(), BACH, false);
  const systems = systemBoxes(sheet);
  const tickOf = (system: number) => {
    const onset = sheet.score.onsets.findIndex((_, i) => systemOf(sheet, i) === system);
    return sheet.score.playOrder.find((step) => step.onsetIndex === onset)!.tick;
  };

  // The wheel is stamped with the wall clock, so the frames read the same clock.
  const t0 = performance.now();
  const restingAt = (system: number) => systems[system]!.top - 600 / 4;

  // Paused, the page stays where it is however far down the band stands.
  sheet.frame(tickOf(3), false, t0);
  expect(scroller.scrollTop).toBe(0);

  // Playing, a system past the upper two thirds glides up until its top is a quarter down.
  sheet.frame(tickOf(3), true, t0);
  sheet.frame(tickOf(3), true, t0 + SCROLL_GLIDE_MS / 2);
  const midway = scroller.scrollTop;
  expect(midway).toBeGreaterThan(0);
  sheet.frame(tickOf(3), true, t0 + SCROLL_GLIDE_MS);
  expect(scroller.scrollTop).toBeGreaterThan(midway);
  expect(Math.abs(scroller.scrollTop - restingAt(3))).toBeLessThanOrEqual(1);
  const settled = scroller.scrollTop;

  // A wheel on the page holds the view for two seconds, then the follow takes it back.
  scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 40 }));
  const wheeled = performance.now();
  sheet.frame(tickOf(6), true, wheeled + 100);
  sheet.frame(tickOf(6), true, wheeled + 100 + SCROLL_GLIDE_MS);
  expect(scroller.scrollTop).toBe(settled);
  sheet.frame(tickOf(6), true, wheeled + DETACH_MS);
  sheet.frame(tickOf(6), true, wheeled + DETACH_MS + SCROLL_GLIDE_MS);
  expect(Math.abs(scroller.scrollTop - restingAt(6))).toBeLessThanOrEqual(1);

  sheet.dispose();
  scroller.remove();
}, 60_000);

/** Top, bottom and top staff line of every system, in pixels of the paper. */
function systemBoxes(sheet: PreviewSheet): { top: number; bottom: number; staffline: number }[] {
  const unit = 10 * sheet.osmd.zoom;
  return systemsOf(sheet.osmd).map((system) => {
    const box = system.PositionAndShape;
    return {
      top: (box.AbsolutePosition.y + box.BorderTop) * unit,
      bottom: (box.AbsolutePosition.y + box.BorderBottom) * unit,
      staffline: (system.StaffLines[0]?.PositionAndShape.AbsolutePosition.y ?? 0) * unit,
    };
  });
}

/** The system an Onset's first notehead prints on. */
function systemOf(sheet: PreviewSheet, onsetIndex: number): number {
  const head = noteheadEl(sheet.osmd, sheet.score.onsets[onsetIndex]!.notes[0]!.source)!;
  const y = (head as unknown as SVGGraphicsElement).getBBox().y;
  return systemBoxes(sheet).findIndex((box) => y >= box.top && y <= box.bottom);
}

/** The x the band is centred on, read back from its transform and its width. */
function bandX(cursor: HTMLElement): number {
  const left = parseFloat(cursor.style.transform.slice('translateX('.length));
  return left + parseFloat(cursor.style.width) / 2;
}
