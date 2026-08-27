// The on-screen keyboard at the foot of the lane canvas: where the falling notes land, and the
// app's only colour legend. Its x axis is the lane's x axis, so a block always falls on its key.

import { INK, NOTE_NAMES, colorOf, isBlackKey, mix, pitchClass, tone } from '@/look/color';
import type { PlayNote } from '@/play/engine';
import type { KeyboardPreset, PlaySettings } from '@/play/settings';

export const KEYBOARD_H = 84;

/** Key faces: ink over paper, 10 % for a white key and 22 % for a black one, as the range strip. */
const KEY_WHITE = ['#dedede', '#343434'] as const;
const KEY_BLACK = ['#c3c3c3', '#4c4c4c'] as const;

/** The narrowest key that still has room for a swatch and a name. */
const LABEL_MIN_W = 11;

/**
 * How far a pressed key sinks, how far its whole face shades, and how much deeper the strip it
 * sinks under is shaded. The face shades as well as sinking, so a press reads on a coloured key.
 */
const PRESS_DROP = 4;
const PRESS_FACE = 0.06;
const PRESS_STRIP = 0.18;

export interface Key {
  midi: number;
  x: number;
  w: number;
  black: boolean;
}

export interface KeyLayout {
  keys: Key[];
  byMidi: Map<number, Key>;
  width: number;
}

/** White keys tile the width; black keys sit narrower on the seam between their neighbours. */
export function keyLayout(lo: number, hi: number, width: number): KeyLayout {
  let whites = 0;
  for (let midi = lo; midi <= hi; midi++) if (!isBlackKey(midi)) whites++;
  const whiteW = width / Math.max(whites, 1);
  const blackW = whiteW * 0.6;
  const keys: Key[] = [];
  let placed = 0;
  for (let midi = lo; midi <= hi; midi++) {
    if (isBlackKey(midi)) {
      keys.push({ midi, x: placed * whiteW - blackW / 2, w: blackW, black: true });
    } else {
      keys.push({ midi, x: placed * whiteW, w: whiteW, black: false });
      placed++;
    }
  }
  return { keys, byMidi: new Map(keys.map((key) => [key.midi, key])), width };
}

const PRESETS: Record<number, [number, number]> = {
  25: [48, 72],
  49: [36, 84],
  61: [36, 96],
  76: [28, 103],
  88: [21, 108],
};

/**
 * The keys the piece is played on. The "piece" preset spans both hands whatever the hands setting
 * says, so switching hands never re-lays the keyboard out under the player's fingers.
 */
export function keyRange(notes: readonly PlayNote[], settings: PlaySettings): [number, number] {
  const preset: KeyboardPreset = settings.keyboardPreset;
  if (preset === 'custom') return [settings.keyboardLo, settings.keyboardHi];
  if (preset !== 'piece') return PRESETS[preset]!;
  let lo = 127;
  let hi = 0;
  for (const note of notes) {
    if (note.midi < lo) lo = note.midi;
    if (note.midi > hi) hi = note.midi;
  }
  if (lo > hi) return [48, 84];
  return [Math.floor(lo / 12) * 12, Math.floor(hi / 12) * 12 + 11];
}

/**
 * Draws the keys as flat rects, blacks over whites. `fill` gives each key its face: the base grey,
 * or whatever the play says it is right now. `depth` gives each key how far down it stands, 0 up
 * and 1 held: its face shades, and it drops under a strip of that face shaded deeper, which
 * sinks with it. The ease that feeds it overshoots, so a depth past 1 or under 0 is a key in
 * motion.
 */
export function drawKeyboard(
  ctx: CanvasRenderingContext2D,
  layout: KeyLayout,
  top: number,
  dark: boolean,
  labels: boolean,
  fill: (midi: number, base: string) => string,
  depth: (midi: number) => number = () => 0,
): void {
  const white = tone(KEY_WHITE, dark);
  const black = tone(KEY_BLACK, dark);
  const blackH = KEYBOARD_H * 0.62;

  for (const key of layout.keys) {
    if (key.black) continue;
    const drop = PRESS_DROP * depth(key.midi);
    const face = shade(fill(key.midi, white), PRESS_FACE * span(drop), dark);
    if (drop > 0) {
      // The strip takes whole pixels, so its edge stays crisp while the face slides over it.
      ctx.fillStyle = shade(face, PRESS_STRIP, dark);
      ctx.fillRect(key.x, top, key.w - 1, Math.ceil(drop));
    }
    ctx.fillStyle = face;
    // The face stops one pixel short: that hairline of paper is what tells two white keys apart.
    ctx.fillRect(key.x, top + drop, key.w - 1, KEYBOARD_H - drop);
  }
  for (const key of layout.keys) {
    if (!key.black) continue;
    // A black key sinks the way a white one does, whole, not by giving up its length.
    const drop = PRESS_DROP * depth(key.midi);
    const face = shade(fill(key.midi, black), PRESS_FACE * span(drop), dark);
    if (drop > 0) {
      ctx.fillStyle = shade(face, PRESS_STRIP, dark);
      ctx.fillRect(key.x, top - 1, key.w, Math.ceil(drop));
    }
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.roundRect(key.x, top - 1 + drop, key.w, blackH, [0, 0, 2, 2]);
    ctx.fill();
  }
  if (labels) drawLabels(ctx, layout, top, blackH, dark);
}

/** How much of the full shade a key this far down takes; past its stop it takes no more. */
const span = (drop: number) => Math.min(drop / PRESS_DROP, 1);

/** A pressed face is its own colour a little way toward the paper's far end, black or white. */
const shade = (face: string, amount: number, dark: boolean) =>
  amount > 0 ? mix(face, dark ? '#ffffff' : '#000000', amount) : face;

/** The legend lives on the keys: a swatch in the pitch colour over the note name. */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  layout: KeyLayout,
  top: number,
  blackH: number,
  dark: boolean,
): void {
  ctx.textAlign = 'center';
  for (const key of layout.keys) {
    if (key.w < LABEL_MIN_W) continue;
    const cx = key.x + key.w / 2;
    const bottom = key.black ? top + blackH - 1 : top + KEYBOARD_H;
    const swatch = key.black ? 8 : 11;
    const y = bottom - 19 - swatch;
    const pc = pitchClass(key.midi);

    ctx.fillStyle = colorOf(key.midi, 'muted', dark);
    ctx.beginPath();
    ctx.roundRect(cx - swatch / 2, y, swatch, swatch, 3);
    ctx.fill();

    // Both faces sit near the paper, so both carry the same ink.
    ctx.fillStyle = tone(INK.duration, dark);
    ctx.font = `${key.black ? 8 : 9}px system-ui, sans-serif`;
    // Only a C carries its octave, which is enough to find your place on the keys.
    ctx.fillText(pc === 0 ? `C${Math.floor(key.midi / 12) - 1}` : NOTE_NAMES[pc]!, cx, bottom - 6);
  }
  ctx.textAlign = 'left';
}
