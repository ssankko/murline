// The sheet's overlays take their fade from the app stylesheet, so the styles it asserts need it.
import '@/index.css';
import { INK, PAPER, colorOf, tone } from '@/look/color';
import { Engine, type NoteState, type SeekTarget, type Snapshot } from '@/play/engine';
import type { Section } from '@/play/section';
import { DEFAULT_PLAY_SETTINGS } from '@/play/settings';
import type { Note } from '@/score/types';
import type { Note as OsmdNote } from 'opensheetmusicdisplay';
import { expect, test } from 'vitest';
import { noteheadEl } from './paint';
import type { Play } from './project';
import { DEFAULT_SPACING, Sheet } from './sheet';

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
/** Short enough to stay one system at every spacing, and long enough that the view scrolls. */
const HORSEMAN = 'Schumann_The_Wild_Horseman_Op._68_No._8.mxl';

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

test('the colour switch drops every notehead to the plain ink and puts the pitch colours back', async () => {
  const sheet = await open();
  const heads = sheet.score.onsets.slice(0, 8).flatMap((onset) => onset.notes);
  const fill = (note: Note) =>
    noteheadEl(sheet.osmd, note.source)?.firstElementChild?.getAttribute('fill');

  sheet.setLook({ colour: false });
  for (const note of heads) expect(fill(note)).toBe(tone(INK.duration, false));

  sheet.setLook({ colour: true });
  for (const note of heads) expect(fill(note)).toBe(colorOf(note.midi, 'muted', false));

  sheet.dispose();
}, 60_000);

test('the current mark rings the notehead outside its fill and comes off again', async () => {
  const sheet = await open();
  const note = sheet.score.onsets[0]!.notes[0]!;
  const path = noteheadEl(sheet.osmd, note.source)!.firstElementChild!;

  // The ring is drawn behind the fill, so the whole pitch colour survives under the cursor band.
  sheet.outline([note], true);
  expect(path.getAttribute('paint-order')).toBe('stroke');
  expect(path.getAttribute('fill')).toBe(colorOf(note.midi, 'muted', false));

  sheet.outline([note], false);
  expect(path.getAttribute('paint-order')).toBe(null);
  expect(path.getAttribute('stroke')).toBe(colorOf(note.midi, 'muted', false));

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

test('the harmony switch takes the chord bubbles off the paper and prints them again', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host);
  const count = () => host.querySelectorAll('.chord-bubble').length;

  expect(count()).toBe(sheet.score.harmony.length);
  sheet.setLook({ harmony: false });
  expect(count()).toBe(0);
  sheet.setLook({ harmony: true });
  expect(count()).toBe(sheet.score.harmony.length);

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

  // Screen pixels, so the band is read where the eye finds it whatever moves it there.
  const box = cursor.getBoundingClientRect();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(box.left + box.width / 2 - host.getBoundingClientRect().left).toBeCloseTo(
    sheet.xOfOnset(0) * scaleOf(host),
    0,
  );

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
  // Outside the Section, starting on the end handle, level with the top of the band.
  expect(button.left).toBeGreaterThanOrEqual(band.right - 5);
  expect(button.left).toBeLessThanOrEqual(band.right);
  expect(button.top).toBeCloseTo(band.top, 0);
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
  expect(getComputedStyle(cursor).transitionTimingFunction).toBe(
    'cubic-bezier(0.65, 0, 0.35, 1), cubic-bezier(0.65, 0, 0.35, 1), cubic-bezier(0.65, 0, 0.35, 1)',
  );

  sheet.dispose();
}, 60_000);

test('the view glides back to the cursor slowest at both ends of the glide', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host);
  const scroll = host.firstElementChild as HTMLElement;
  // One tick far enough along the line that holding the cursor 30 % from the left edge scrolls.
  const at = (now: number) => {
    sheet.frame(snapshot(sheet.score.playOrder[200]!.tick, { stepIndex: 200 }), 100, now);
    return scroll.scrollLeft;
  };

  // The first running frame attaches the view and glides it in from where the reader left it.
  const from = at(0);
  const to = at(300);
  expect(to).toBeGreaterThan(from);

  // Symmetric: half the time covers half the travel, and the first tenth of it covers almost none.
  // The view scrolls in whole pixels, so the midpoint reads back rounded.
  expect(Math.abs(at(150) - (from + to) / 2)).toBeLessThanOrEqual(1);
  expect(at(30) - from).toBeLessThan((to - from) * 0.1);

  sheet.dispose();
}, 60_000);

test('a seek while the play runs glides the cursor band either way', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host);
  const cursor = host.querySelector<HTMLElement>('.sheet-cursor')!;
  const run = (step: number, now: number) =>
    sheet.frame(snapshot(sheet.score.playOrder[step]!.tick, { stepIndex: step }), 100, now);

  // The clock walking from one step to the next writes the x flat, so the band keeps the beat.
  run(0, 0);
  run(1, 16);
  expect(getComputedStyle(cursor).transitionProperty).toBe('width, height, top');

  // A forward seek: the band glides to the new bar instead of appearing there.
  run(80, 32);
  expect(getComputedStyle(cursor).transitionProperty).toBe('width, height, top, transform');
  expect(getComputedStyle(cursor).transitionDuration).toBe('0.2s, 0.2s, 0.2s, 0.22s');

  // A backward seek glides as well, and the window closes 220 ms after the seek.
  run(2, 48);
  expect(getComputedStyle(cursor).transitionProperty).toBe('width, height, top, transform');
  run(3, 268);
  expect(getComputedStyle(cursor).transitionProperty).toBe('width, height, top');

  sheet.dispose();
}, 60_000);

test('a seek while the play is still glides the view only when the cursor lands off it', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host);
  const scroll = host.firstElementChild as HTMLElement;
  const idle = (step: number, now: number) => {
    const at = snapshot(sheet.score.playOrder[step]!.tick, { state: 'idle', stepIndex: step });
    sheet.frame(at, 100, now);
    return scroll.scrollLeft;
  };

  // The first frame scales the content, which is what turns an Onset's x into screen pixels.
  expect(idle(0, 0)).toBe(0);
  const scale = scaleOf(host);
  const followOf = (step: number) =>
    sheet.xOfOnset(sheet.score.playOrder[step]!.onsetIndex) * scale - scroll.clientWidth * 0.3;

  // A far bar lands the cursor off the view: the paper glides after it and settles on the follow
  // position, the cursor 30 % from the left edge.
  expect(idle(200, 16)).toBe(0);
  const mid = idle(200, 166);
  expect(mid).toBeGreaterThan(0);
  expect(mid).toBeLessThan(followOf(200));
  expect(Math.abs(idle(200, 316) - followOf(200))).toBeLessThanOrEqual(1);

  // A seek onto paper the reader can already see leaves the view where he put it.
  const held = scroll.scrollLeft;
  const near = sheet.score.playOrder.findIndex(
    (step) => sheet.xOfOnset(step.onsetIndex) * scale - held > scroll.clientWidth * 0.5,
  );
  expect(near).toBeGreaterThan(202);
  expect(idle(near, 332)).toBe(held);
  expect(idle(near, 482)).toBe(held);

  sheet.dispose();
}, 60_000);

test('a resize scales the sheet around the cursor and never moves it on screen', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host);
  const scroll = host.firstElementChild as HTMLElement;
  const cursor = host.querySelector<HTMLElement>('.sheet-cursor')!;
  // Where the band stands in the block the reader sees, whatever scale and scroll put it there.
  // The band is read at its middle, the cursor's own x; its width is paper and scales with it.
  const standing = () => {
    const box = cursor.getBoundingClientRect();
    return box.left + box.width / 2 - scroll.getBoundingClientRect().left;
  };
  const step = 200;
  const frame = (now: number, state: Snapshot['state']) =>
    sheet.frame(snapshot(sheet.score.playOrder[step]!.tick, { state, stepIndex: step }), 100, now);

  // A bar mid-piece, the view glided onto it: paper stands on both sides of the cursor.
  frame(0, 'idle');
  frame(400, 'idle');
  expect(scroll.scrollLeft).toBeGreaterThan(0);

  // Idle, and the split drags the sheet block shorter: the paper shrinks around the cursor.
  const stood = standing();
  const scale = scaleOf(host);
  host.style.height = '150px';
  frame(416, 'idle');
  expect(scaleOf(host)).toBeLessThan(scale);
  expect(Math.abs(standing() - stood)).toBeLessThanOrEqual(1);

  // Detached: the reader holds the view, and a taller block leaves the cursor where they see it.
  host.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
  frame(432, 'idle');
  const held = standing();
  host.style.height = '260px';
  frame(448, 'idle');
  expect(scaleOf(host)).toBeGreaterThan(scale);
  expect(Math.abs(standing() - held)).toBeLessThanOrEqual(1);

  // Attached: the view follows the cursor, and the resize neither jumps it nor glides it.
  frame(1000, 'running');
  frame(1400, 'running');
  const followed = standing();
  host.style.height = '190px';
  frame(1416, 'running');
  expect(Math.abs(standing() - followed)).toBeLessThanOrEqual(1);
  frame(1432, 'running');
  expect(Math.abs(standing() - followed)).toBeLessThanOrEqual(1);

  sheet.dispose();
}, 60_000);

test('a click seeks to the nearest Onset, over a bar line and far from any notehead', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host);
  let sought: SeekTarget | null = null;
  sheet.onSeek = (target) => {
    sought = target;
  };

  // No frame has run, so the content is unscaled and unscrolled: a content x is a client x.
  const left = host.getBoundingClientRect().left;
  const click = (x: number) => {
    sought = null;
    const at = { clientX: left + x, bubbles: true };
    host.dispatchEvent(new PointerEvent('pointerdown', { ...at, button: 0 }));
    host.dispatchEvent(new PointerEvent('pointerup', at));
    return sought;
  };
  const between = (a: number, b: number, part: number) =>
    sheet.xOfOnset(a) + (sheet.xOfOnset(b) - sheet.xOfOnset(a)) * part;

  // Between two Onsets of one bar the click goes to whichever is the closer.
  expect(click(between(2, 3, 0.4))).toEqual({ onset: 2 });
  expect(click(between(2, 3, 0.6))).toEqual({ onset: 3 });

  // Past the last notehead of a bar, well beyond any notehead, the click still means that note.
  const last = sheet.score.onsets.findLastIndex((onset) => onset.measureIndex === 0);
  expect(sheet.score.onsets[last + 1]!.measureIndex).toBe(1);
  expect(between(last, last + 1, 0.4) - sheet.xOfOnset(last)).toBeGreaterThan(11);
  expect(click(between(last, last + 1, 0.4))).toEqual({ onset: last });

  sheet.dispose();
}, 60_000);

test('the count-in runs a line towards the cursor, which stands where the count-in leads', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host);
  const cursor = host.querySelector<HTMLElement>('.sheet-cursor')!;
  const runner = host.querySelector<HTMLElement>('.sheet-runner')!;
  const countIn = (playedTick: number) =>
    snapshot(playedTick, { state: 'counting-in', countInTo: 0 });
  // Both lines hang at the left edge of the content and travel by transform, so their place is
  // read back from the x they were moved to and their own width.
  const middleOf = (el: HTMLElement) => new DOMMatrix(el.style.transform).e + el.offsetWidth / 2;

  // A count-in into the first Onset counts at ticks before the walk, so the runner comes in from
  // the left of it rather than parking on it.
  sheet.frame(countIn(-480), 100, 0);
  const far = middleOf(runner);
  const stood = cursor.style.transform;
  expect(runner.style.display).toBe('block');
  expect(far).toBeGreaterThan(0);
  expect(far).toBeLessThan(sheet.xOfOnset(0) - 1);

  sheet.frame(countIn(-120), 100, 16);
  const near = middleOf(runner);
  expect(near).toBeGreaterThan(far);
  expect(near).toBeLessThan(sheet.xOfOnset(0));
  // The real cursor never moves through a count-in: it waits at the tick the count-in leads to.
  expect(cursor.style.transform).toBe(stood);
  expect(middleOf(cursor)).toBeCloseTo(sheet.xOfOnset(0), 0);

  // A count-in longer than the paper left of the first Onset holds the runner at the edge.
  sheet.frame(countIn(-19200), 100, 32);
  expect(middleOf(runner)).toBe(0);

  // Motion takes the runner off the paper.
  sheet.frame(snapshot(0), 100, 48);
  expect(runner.style.display).toBe('none');

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

/** What the sheet is scaled to: the SVG's screen width over the width it was drawn at. */
function scaleOf(host: HTMLElement): number {
  const svg = host.querySelector('svg')!;
  return svg.getBoundingClientRect().width / Number(svg.getAttribute('width'));
}

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

function snapshot(playedTick: number, over: Partial<Snapshot> = {}): Snapshot {
  return {
    state: 'running',
    kind: 'practice',
    playedTick,
    stepIndex: 0,
    countInTo: 0,
    stopped: false,
    ...over,
  };
}

/** A play the sheet can project, standing in for the engine with the states a test wants. */
function play(notes: readonly Note[], stateOf: (index: number) => NoteState, version: number): Play {
  return {
    version,
    notes: notes.map((note) => ({ note, tick: note.onsetTick })),
    noteState: stateOf,
  };
}

function fillOf(sheet: Sheet, source: OsmdNote): string | null | undefined {
  return noteheadEl(sheet.osmd, source)?.firstElementChild?.getAttribute('fill');
}

test("the play's note states are projected over the whole sheet, the outline with them", async () => {
  const sheet = await open();
  // The cursor stands at the first Onset, which the frame outlines.
  sheet.frame(snapshot(0), 0, 0);
  const notes = sheet.score.onsets.flatMap((onset) => onset.notes);
  const first = notes[0]!;
  const last = notes[notes.length - 1]!;

  // Everything the play skipped greys at once, everything else reads as never played.
  sheet.project(play(notes, (index) => (index < notes.length / 2 ? 'miss' : 'pending'), 1), Infinity);
  expect(fillOf(sheet, first.source)).toBe(tone(INK.miss, false));
  expect(fillOf(sheet, last.source)).toBe(colorOf(last.midi, 'muted', false));
  // The repaint went over the Onset the cursor stands at, which keeps its ring.
  expect(
    noteheadEl(sheet.osmd, first.source)!.firstElementChild!.getAttribute('paint-order'),
  ).toBe('stroke');

  sheet.project(play(notes, () => 'pending', 2), Infinity);
  expect(fillOf(sheet, first.source)).toBe(colorOf(first.midi, 'muted', false));

  // A projection of the same version changes nothing, however the states read.
  sheet.project(play(notes, () => 'miss', 2), Infinity);
  expect(fillOf(sheet, first.source)).toBe(colorOf(first.midi, 'muted', false));

  sheet.dispose();
}, 60_000);

test('a missed tie greys its whole chain, and the colour comes back to all of it', async () => {
  const sheet = await open();
  const notes = sheet.score.onsets.flatMap((onset) => onset.notes);
  const start = notes.find((note) => {
    const tie = note.source.NoteTie;
    return tie && tie.StartNote === note.source && tie.Notes.length > 1;
  })!;
  const held = start.source.NoteTie!.Notes[1]!;

  // Only the note that starts the tie is ever struck, so only it is missed; the head it sounds on
  // must go grey with it.
  sheet.project(play([start], () => 'miss', 1), Infinity);
  expect(fillOf(sheet, start.source)).toBe(tone(INK.miss, false));
  expect(fillOf(sheet, held)).toBe(tone(INK.miss, false));

  sheet.project(play([start], () => 'hit', 2), Infinity);
  expect(fillOf(sheet, start.source)).toBe(colorOf(start.midi, 'muted', false));
  expect(fillOf(sheet, held)).toBe(colorOf(start.midi, 'muted', false));

  sheet.dispose();
}, 60_000);

// The Bach holds ties over bar lines and the volta fixture plays its bars twice: both mappings have
// to come off the engine the way the lane reads it.
for (const file of [BACH, VOLTA]) {
  test(`every notehead of ${file} reads what the engine gives the lane`, async () => {
    const sheet = await open(file);
    const engine = new Engine(sheet.score, { ...DEFAULT_PLAY_SETTINGS, countInBars: 0 });
    const repeated = engine.notes.some(
      ({ note }, i) => engine.notes.findIndex((other) => other.note === note) !== i,
    );
    expect(repeated || engine.notes.some(({ note }) => note.tiedFrom)).toBe(true);

    /** The colour the lane's rule gives each head, with the tie and repeat mapping applied. */
    const wanted = (playedTick: number) => {
      const colours = new Map<OsmdNote, string>();
      engine.notes.forEach(({ note, tick }, index) => {
        if (tick > playedTick || note.tiedFrom) return;
        const state = engine.noteState(index);
        const colour = state === 'miss' ? tone(INK.miss, false) : colorOf(note.midi, 'muted', false);
        const tie = note.source.NoteTie;
        for (const head of tie?.StartNote === note.source ? tie.Notes : [note.source]) {
          colours.set(head, colour);
        }
      });
      return colours;
    };

    const agrees = (): number => {
      const snap = engine.snapshot();
      sheet.project(engine, snap.playedTick);
      sheet.frame(snap, engine.windowTicks, 0);
      const colours = wanted(snap.playedTick);
      for (const [source, colour] of colours) expect(fillOf(sheet, source)).toBe(colour);
      return colours.size;
    };

    // A forward seek: every expected note behind the cursor was skipped, whatever pass it fell in.
    const half = Math.floor(sheet.score.playOrder.length / 2);
    engine.seek({ tick: sheet.score.playOrder[half]!.tick });
    expect(agrees()).toBeGreaterThan(0);
    expect(engine.notes.some((_, i) => engine.noteState(i) === 'miss')).toBe(true);

    // A live miss: the clock runs on and nothing is played at the notes it passes.
    engine.start();
    engine.advance(2000);
    expect(agrees()).toBeGreaterThan(0);

    sheet.dispose();
  }, 60_000);
}

/**
 * Pixels per tick over each step inside one bar, against that bar's own average. The step out of
 * the bar is left out: it crosses the bar line and the instructions after it, which are paper no
 * duration asks for.
 */
function speeds(sheet: Sheet, measure: number): number[] {
  const walk = sheet.score.onsets
    .map((onset, i) => ({ tick: onset.tick, x: sheet.xOfOnset(i), measure: onset.measureIndex }))
    .filter((onset) => onset.measure === measure);
  if (walk.length < 3) return [];
  const last = walk[walk.length - 1]!;
  const mean = (last.x - walk[0]!.x) / (last.tick - walk[0]!.tick);
  return walk.slice(1).map((onset, i) => (onset.x - walk[i]!.x) / (onset.tick - walk[i]!.tick) / mean);
}

/** x of the first Onset of every bar. */
function bars(sheet: Sheet): number[] {
  return sheet.score.measures.map((measure) =>
    sheet.xOfOnset(sheet.score.onsets.findIndex((onset) => onset.measureIndex === measure.index)),
  );
}

test('spacing by time gives every bar the width of its duration, and gives it back', async () => {
  const sheet = await open();
  const spreadOf = (bar: number) =>
    Math.max(0, ...speeds(sheet, bar).map((rate) => Math.abs(rate - 1)));
  const engraved = bars(sheet);
  const wasSpread = sheet.score.measures.slice(0, -1).map((measure) => spreadOf(measure.index));

  sheet.setProportional(true);
  const spaced = bars(sheet);
  // The sheet opens up: no bar is asked for less width than its own notes pack into.
  expect(spaced[spaced.length - 1]).toBeGreaterThan(engraved[engraved.length - 1]! * 1.4);

  // Every bar of the prelude is a full 4/4 bar, so they all take the same width.
  expect(new Set(sheet.score.measures.map((measure) => measure.durationTicks)).size).toBe(1);
  const steps = spaced.slice(1).map((x, i) => x - spaced[i]!);
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  for (const step of steps) expect(Math.abs(step / mean - 1)).toBeLessThan(0.04);

  // Engraved, VexFlow packs each notehead against the next and every step of a bar has a speed of
  // its own; spaced by time, every Onset stands at its own tick.
  expect(Math.max(...wasSpread)).toBeGreaterThan(0.2);
  const now = sheet.score.measures.slice(0, -1).map((measure) => spreadOf(measure.index));
  expect(Math.max(...now)).toBeLessThan(0.01);

  sheet.setProportional(false);
  expect(bars(sheet)).toEqual(engraved);

  sheet.dispose();
}, 60_000);

test('the cursor keeps one speed and one width over a sheet spaced by time', async () => {
  const sheet = await open();
  sheet.setProportional(true);
  const window = 480;

  // The band matches a window of time, and the sheet has one pixels per tick, so it never changes
  // size wherever the play stands.
  const widths = Array.from(
    { length: 10 },
    (_, i) => sheet.cursorAt(Math.round(((i + 0.5) / 10) * sheet.score.totalTicks), 0, window).width,
  );
  expect(new Set(widths).size).toBe(1);
  expect(widths[0]).toBeGreaterThan(2);

  // Speed sampled inside the steps and across them, everywhere but over a bar line. The first bar
  // is left out: it carries the clef, the key and the time signature, and OSMD hands it more paper
  // than its duration asks for.
  const step = 30;
  const rates: number[] = [];
  const onsets = sheet.score.onsets;
  for (let i = 1; i < onsets.length; i++) {
    if (onsets[i]!.measureIndex !== onsets[i - 1]!.measureIndex) continue;
    if (onsets[i]!.measureIndex === 0) continue;
    for (let tick = onsets[i - 1]!.tick; tick + step <= onsets[i]!.tick; tick += step) {
      const from = sheet.cursorAt(tick, 0, window).x;
      rates.push((sheet.cursorAt(tick + step, 0, window).x - from) / step);
    }
  }
  const perTick = rates.reduce((a, b) => a + b, 0) / rates.length;
  expect(rates.length).toBeGreaterThan(1000);
  expect(Math.max(...rates.map((rate) => Math.abs(rate / perTick - 1)))).toBeLessThan(0.001);

  // Every notehead stands under the band at its own tick, at that one pixels per tick.
  for (const measure of sheet.score.measures.slice(1)) {
    const first = onsets.findIndex((onset) => onset.measureIndex === measure.index);
    if (first < 0) continue;
    for (let i = first; i < onsets.length && onsets[i]!.measureIndex === measure.index; i++) {
      const want = sheet.xOfOnset(first) + (onsets[i]!.tick - onsets[first]!.tick) * perTick;
      expect(Math.abs(sheet.xOfOnset(i) - want)).toBeLessThan(0.1);
    }
  }

  sheet.dispose();
}, 60_000);

test('a sheet spaced by time draws every mark at the notes it moved', async () => {
  const host = hostEl();
  const sheet = await open(MAZURKA, host);
  sheet.setProportional(true);
  const svg = host.querySelector('svg')!;
  const heads = [...svg.querySelectorAll('.vf-notehead')].map((el) =>
    (el as SVGGraphicsElement).getBBox(),
  );
  expect(heads.length).toBeGreaterThan(500);
  // Every mark VexFlow and OSMD draw takes its place from the notes at draw time, so both ends of
  // one stand at a notehead, a hook beam reaching back off its stem and a slur arcing past the
  // heads it joins. A mark left behind at its engraved place would be bars away: spacing by time
  // carries the far end of this sheet several thousand pixels.
  const near = (x: number) => heads.some((box) => x > box.x - 20 && x < box.x + box.width + 20);
  for (const mark of svg.querySelectorAll('.vf-stem, .vf-beam, .vf-stavetie, .vf-slur')) {
    const box = (mark as SVGGraphicsElement).getBBox();
    expect(near(box.x)).toBe(true);
    expect(near(box.x + box.width)).toBe(true);
  }

  sheet.dispose();
}, 60_000);

test('the spacing knob opens a sheet spaced by time up and packs it back', async () => {
  const sheet = await open();
  const last = () => sheet.xOfOnset(sheet.score.onsets.length - 1);

  sheet.setProportional(true);
  const wide = last();
  sheet.setSpacing(100);
  const tight = last();
  expect(tight).toBeLessThan(wide * 0.8);
  sheet.setSpacing(DEFAULT_SPACING);
  expect(last()).toBe(wide);

  sheet.dispose();
}, 60_000);

test('a bar of long notes is spaced as wide as a bar of short ones', async () => {
  const sheet = await open('MuzioClementi_SonatinaOpus36No1_Part1.xml');
  // The Sonatina writes bars of very different note counts, all of one duration.
  expect(new Set(sheet.score.measures.map((measure) => measure.durationTicks)).size).toBe(1);
  const spreadOf = () => {
    const steps = bars(sheet).slice(1).map((x, i) => x - bars(sheet)[i]!);
    const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
    return Math.max(...steps.map((step) => Math.abs(step / mean - 1)));
  };

  // Engraved, a bar takes the width its notes need; spaced by time, the width its duration asks.
  expect(spreadOf()).toBeGreaterThan(0.2);
  sheet.setProportional(true);
  expect(spreadOf()).toBeLessThan(0.08);

  sheet.dispose();
}, 60_000);

/** A pinch on the trackpad, which reaches the page as a wheel with ctrl held. */
function pinch(host: HTMLElement, deltaY: number): WheelEvent {
  const event = new WheelEvent('wheel', { deltaY, ctrlKey: true, bubbles: true, cancelable: true });
  host.dispatchEvent(event);
  return event;
}

/** Real time, which the throttle behind a pinch runs on. */
function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

test('a pinch spaces the sheet by time around the cursor and stops at the clamps', async () => {
  const host = hostEl();
  const sheet = await open(HORSEMAN, host);
  const scroll = host.firstElementChild as HTMLElement;
  const stored: { spacing: number }[] = [];
  sheet.onLook = (look) => void stored.push(look);
  sheet.setProportional(true);

  const step = 60;
  const tick = sheet.score.playOrder[step]!.tick;
  const frame = (now: number) =>
    sheet.frame(snapshot(tick, { state: 'idle', stepIndex: step }), 100, now);
  /** Where the cursor stands in the block the reader sees. */
  const standing = () => sheet.cursorAt(tick, step, 100).x * scaleOf(host) - scroll.scrollLeft;
  const width = () => sheet.xOfOnset(sheet.score.onsets.length - 1);

  // A bar mid-piece, the view glided onto it: paper stands on both sides of the cursor.
  frame(0);
  frame(400);
  expect(scroll.scrollLeft).toBeGreaterThan(0);

  const tight = width();
  const stood = standing();
  pinch(host, -20);
  pinch(host, -20);
  pinch(host, -20);
  // The throttle lets the first step through and holds the rest; the newest target lands after it.
  const first = width();
  expect(first).toBeGreaterThan(tight);
  await wait(200);
  expect(width()).toBeGreaterThan(first);
  // The paper opened up around the cursor, which never moved in the block the reader sees.
  expect(Math.abs(standing() - stood)).toBeLessThanOrEqual(1);

  // The spacing the pinch settled on is handed over once, and it stands inside the 100 to 300 range.
  await wait(300);
  expect(stored.length).toBe(1);
  expect(stored[0]!.spacing).toBeGreaterThan(250);
  expect(stored[0]!.spacing).toBeLessThanOrEqual(300);

  // However far the fingers spread or pinch, the sheet stops at the ends of that range.
  for (let i = 0; i < 4; i++) pinch(host, -100);
  await wait(200);
  const widest = width();
  sheet.setSpacing(300);
  expect(width()).toBe(widest);
  for (let i = 0; i < 4; i++) pinch(host, 100);
  await wait(200);
  const tightest = width();
  sheet.setSpacing(100);
  expect(width()).toBe(tightest);
  expect(tightest).toBeLessThan(widest);

  sheet.dispose();
}, 60_000);

test('a pinch leaves a sheet spaced by its engraving alone', async () => {
  const host = hostEl();
  const sheet = await open(BACH, host);
  const stored: { spacing: number }[] = [];
  sheet.onLook = (look) => void stored.push(look);
  const engraved = sheet.xOfOnset(sheet.score.onsets.length - 1);

  // The page must never zoom under the fingers, whatever the sheet does with them.
  expect(pinch(host, -60).defaultPrevented).toBe(true);
  await wait(400);
  expect(sheet.xOfOnset(sheet.score.onsets.length - 1)).toBe(engraved);
  expect(stored).toEqual([]);

  sheet.dispose();
}, 60_000);
