// The sheet's overlays take their fade from the app stylesheet, so the styles it asserts need it.
import '@/index.css';
import { INK, PAPER, colorOf, tone } from '@/look/color';
import type { Snapshot } from '@/play/engine';
import type { Section } from '@/play/section';
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
/** Slurs arc high over its top staff, well above every label of the first bars. */
const MAZURKA = 'kernscores-mazurka-50.musicxml';

async function bytesOf(file: string): Promise<Uint8Array> {
  const url = FIXTURES[`../score/fixtures/${file}`] as string;
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

function hostEl(): HTMLElement {
  const host = document.createElement('div');
  host.style.cssText = 'width:900px;height:220px';
  document.body.append(host);
  return host;
}

async function open(file = BACH, host = hostEl(), dark = false): Promise<Sheet> {
  return Sheet.open(host, await bytesOf(file), file, dark);
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

test('the current mark rings the notehead outside its fill and comes off again', async () => {
  const sheet = await open();
  const note = sheet.score.onsets[0]!.notes[0]!;
  const path = noteheadEl(sheet.osmd, note.source)!.firstElementChild!;

  // The ring is drawn behind the fill, so the whole pitch colour survives under the cursor band.
  sheet.markNote(note, 'current');
  expect(path.getAttribute('paint-order')).toBe('stroke');
  expect(path.getAttribute('fill')).toBe(colorOf(note.midi, 'muted', false));

  sheet.markNote(note, 'none');
  expect(path.getAttribute('paint-order')).toBe(null);

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

test('the lift keeps the highest ink of the sheet on the paper', async () => {
  const host = hostEl();
  const sheet = await open(MAZURKA, host);
  sheet.frame(snapshot(0), 100, 0);

  const drawn = [...host.querySelectorAll('svg path, svg rect, svg text')];
  const ink = Math.min(...drawn.map((el) => el.getBoundingClientRect().top));
  expect(ink).toBeGreaterThanOrEqual(host.getBoundingClientRect().top);

  sheet.dispose();
}, 60_000);

test('the tempo word and the first chord bubble print clear of the tempo mark', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host);

  const word = [...host.querySelectorAll('svg text')].find((el) => el.textContent === 'Andante')!;
  const mark = host.querySelector('svg .vf-stavetempo')!;
  const bubble = host.querySelector('.chord-bubble')!.getBoundingClientRect();
  expect(word.getBoundingClientRect().width).toBeGreaterThan(0);
  expect(overlap(word.getBoundingClientRect(), mark.getBoundingClientRect())).toBeLessThanOrEqual(0);
  expect(overlap(bubble, word.getBoundingClientRect())).toBeLessThanOrEqual(0);
  expect(overlap(bubble, mark.getBoundingClientRect())).toBeLessThanOrEqual(0);

  sheet.dispose();
}, 60_000);

test('a disposed sheet leaves its host empty for the next one', async () => {
  const host = hostEl();
  const first = await open(BACH, host);
  first.dispose();

  expect(host.children.length).toBe(0);

  const second = await open(BACH, host);
  expect(host.querySelectorAll('#osmdCanvasPage1').length).toBe(1);
  expect(host.querySelectorAll('svg').length).toBe(1);

  second.dispose();
}, 60_000);

test('a sheet opened over one still in flight is the only one left on the paper', async () => {
  const host = hostEl();
  const bytes = await bytesOf(BACH);
  // What StrictMode does: one host, two opens in flight at once, and the sheet of the mount React
  // threw away is dropped as soon as its open lands.
  const flying = Sheet.open(host, bytes, BACH, false);
  const live = await Sheet.open(host, bytes, BACH, false);
  (await flying).dispose();

  expect(host.querySelectorAll('svg').length).toBe(1);
  expect(host.contains(headOf(live))).toBe(true);

  live.dispose();
}, 60_000);

test('the paper of a dark sheet is the dark tone', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host, true);

  expect(host.querySelector('svg')?.style.backgroundColor).toBe(hexToRgb(tone(PAPER, true)));

  sheet.dispose();
}, 60_000);

test('the cursor band stands over the first Onset', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host);

  sheet.frame(snapshot(0), 100, 0);
  const cursor = host.querySelector<HTMLElement>('.sheet-cursor')!;

  expect(cursor.offsetWidth).toBeGreaterThan(0);
  expect(cursor.offsetHeight).toBeGreaterThan(0);
  expect(cursor.offsetLeft + cursor.offsetWidth / 2).toBeCloseTo(sheet.xOfOnset(0), 0);

  sheet.dispose();
}, 60_000);

test('the Section fades in and hangs its clear button inside the tint', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host);
  const tint = host.querySelector<HTMLElement>('.sheet-section')!;
  const clear = host.querySelector<HTMLElement>('.sheet-section-clear')!;

  expect(getComputedStyle(tint).transitionProperty).toContain('opacity');
  expect(getComputedStyle(tint).display).toBe('none');

  sheet.setSection({ from: 0, to: 2 });
  expect(getComputedStyle(tint).display).toBe('block');
  // Layout pixels, so the sheet's fit-to-height scale cannot read the button smaller than it is.
  expect(Math.min(clear.offsetWidth, clear.offsetHeight)).toBeGreaterThanOrEqual(18);

  const band = tint.getBoundingClientRect();
  const button = clear.getBoundingClientRect();
  expect(button.left).toBeGreaterThanOrEqual(band.left);
  expect(button.right).toBeLessThanOrEqual(band.right);
  expect(button.top).toBeGreaterThanOrEqual(band.top);
  expect(button.bottom).toBeLessThanOrEqual(band.bottom);
  expect(clear.getAttribute('aria-label')).toBe('Clear section');

  sheet.setSection(null);
  expect(tint.classList.contains('on')).toBe(false);

  sheet.dispose();
}, 60_000);

test('the cursor band eases into a new size and takes its first one flat', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host);
  const cursor = host.querySelector<HTMLElement>('.sheet-cursor')!;

  sheet.frame(snapshot(0), 100, 0);
  expect(getComputedStyle(cursor).transitionProperty).toBe('none');

  // The clock runs forward, so the x is written every frame and only the size eases.
  sheet.frame(snapshot(0), 100, 16);
  expect(getComputedStyle(cursor).transitionProperty).toBe('width, height, top');
  expect(getComputedStyle(cursor).transitionDuration).toBe('0.2s, 0.2s, 0.2s');

  sheet.dispose();
}, 60_000);

test('a drag that starts outside the Section picks a fresh one there', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host);
  let picked: Section | null = null;
  sheet.onSection = (section) => {
    picked = section;
    sheet.setSection(section);
  };
  sheet.setSection({ from: 2, to: 3 });

  // No frame has run, so the content is unscaled and unscrolled: a content x is a client x.
  const left = host.getBoundingClientRect().left;
  const barSix = sheet.score.onsets.findIndex((onset) => onset.measureIndex === 6);
  const x = left + sheet.xOfOnset(barSix);
  host.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, button: 0, bubbles: true }));
  host.dispatchEvent(new PointerEvent('pointermove', { clientX: x + 30, buttons: 1, bubbles: true }));
  host.dispatchEvent(new PointerEvent('pointerup', { clientX: x + 30, bubbles: true }));

  expect(picked).toEqual({ from: 6, to: 6 });

  sheet.dispose();
}, 60_000);

test('a fast resize chases the last bar line and never queues the ones before it', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host);
  const tint = host.querySelector<HTMLElement>('.sheet-section')!;
  const at = () => parseFloat(getComputedStyle(tint).left);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 320));
  sheet.onSection = (section) => sheet.setSection(section);

  sheet.setSection({ from: 0, to: 1 });
  await settle();
  const start = at();

  // Mid-drag: the band snaps to whole bars, so its edges glide between bar lines under the pointer.
  const x = host.getBoundingClientRect().left + sheet.xOfOnset(0);
  host.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, button: 0, bubbles: true }));
  host.dispatchEvent(new PointerEvent('pointermove', { clientX: x + 60, buttons: 1, bubbles: true }));
  expect(getComputedStyle(tint).transitionProperty).toBe('opacity, display, left, width');
  host.dispatchEvent(new PointerEvent('pointerup', { clientX: x + 60, bubbles: true }));

  // Three bar lines in one task, as a drag across three bars hands them over frame by frame.
  sheet.setSection({ from: 4, to: 5 });
  sheet.setSection({ from: 8, to: 9 });
  sheet.setSection({ from: 12, to: 13 });
  const target = parseFloat(tint.style.left);
  expect(target).toBeGreaterThan(start);

  await new Promise((resolve) => setTimeout(resolve, 60));
  const mid = at();
  expect(mid).toBeGreaterThan(start);
  expect(mid).toBeLessThan(target);

  // A fourth change in flight picks the band up where it stands instead of dropping it back.
  sheet.setSection({ from: 20, to: 21 });
  expect(at()).toBeGreaterThanOrEqual(mid);
  expect(at()).toBeLessThan(target);

  sheet.setSection({ from: 12, to: 13 });
  await settle();
  expect(at()).toBeCloseTo(target, 0);

  sheet.dispose();
}, 60_000);

/** How far two boxes print over one another: at zero or below they only share an edge. */
function overlap(a: DOMRect, b: DOMRect): number {
  return Math.min(
    Math.min(a.right, b.right) - Math.max(a.left, b.left),
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
  );
}

/** A notehead of the sheet's first Onset: which host it hangs in says which render is on screen. */
function headOf(sheet: Sheet): HTMLElement {
  return noteheadEl(sheet.osmd, sheet.score.onsets[0]!.notes[0]!.source)!;
}

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

function snapshot(playedTick: number): Snapshot {
  return {
    state: 'running',
    kind: 'practice',
    playedTick,
    stepIndex: 0,
    stopped: false,
  };
}
