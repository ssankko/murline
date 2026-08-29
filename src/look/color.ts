// The one colour rule of the app: `colorOf` turns a MIDI number into the hex its notehead, its
// falling block and its key swatch are painted in. Every caller goes through it.

import { isBlackKey, pitchClass } from '@/score/pitch';

export type Palette = 'muted' | 'full';

// Hue per pitch class, C red through B magenta. Each sharp sits on the hue midway between its
// neighbouring naturals, then drops in saturation and lightness so it never reads as its natural.
const HUES = [3, 20, 38, 55, 72, 135, 163, 190, 222, 253, 292, 330];
const SHARP_S = -24;
const SHARP_L = -16;

// The muted tier every block and swatch wears, and the full tier a note reaching the now-line
// takes: the same hue a step up in saturation, enough to read as the pitch turned up and no more.
const TONE: Record<Palette, { s: number; l: number }> = {
  muted: { s: 60, l: 50 },
  full: { s: 72, l: 48 },
};

// Dark paper swallows a mid-lightness colour, so every hue rises by this much on it.
const DARK_LIFT = 10;

function hslHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * v)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

export function colorOf(midi: number, palette: Palette = 'muted', dark = false): string {
  const tone = TONE[palette];
  const sharp = isBlackKey(midi);
  return hslHex(
    HUES[pitchClass(midi)]!,
    tone.s + (sharp ? SHARP_S : 0),
    tone.l + (sharp ? SHARP_L : 0) + (dark ? DARK_LIFT : 0),
  );
}

// Three ink tiers for the sheet, plus the paper grey every screen sits on. Light value first, dark
// second; the CSS variables in src/index.css carry the same greys for the DOM. `miss` holds no
// saturation, so a dead note never reads as one of the twelve pitch colours.
export const INK = {
  scaffolding: ['#9a9a9a', '#6a6a6a'],
  duration: ['#5a5a5a', '#d0d0d0'],
  miss: ['#6b6b6b', '#b4b4b4'],
} as const;

export const PAPER = ['#f4f4f4', '#202020'] as const;
export const CURSOR = ['#c9922e', '#d9a83c'] as const;

/** Picks the light or dark member of one of the constants above, or of any other paper pair. */
export function tone<T>(pair: readonly [T, T], dark: boolean): T {
  return dark ? pair[1] : pair[0];
}

/** A blend of two `#rrggbb` colours, `t` of the way from the first to the second. */
export function mix(from: string, to: string, t: number): string {
  const channel = (i: number) => {
    const a = parseInt(from.slice(1 + i * 2, 3 + i * 2), 16);
    const b = parseInt(to.slice(1 + i * 2, 3 + i * 2), 16);
    return Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/** A `#rrggbb` carrying an alpha, which a gradient stop needs and `globalAlpha` cannot give. */
export function withAlpha(hex: string, a: number): string {
  const byte = Math.round(Math.min(Math.max(a, 0), 1) * 255);
  return hex + byte.toString(16).padStart(2, '0');
}

/** How bright a colour is to the eye, on the WCAG scale the contrast ratio is read off. */
export function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/** The luminance of a mid grey, where a fill stops carrying the light paper's ink. */
const LABEL_FLIP = 0.275;

/**
 * The ink a label printed straight on `fill` wears: the dark paper or the light one, whichever the
 * fill's luminance leaves readable.
 */
export function labelInk(fill: string): string {
  return luminance(fill) > LABEL_FLIP ? PAPER[1] : PAPER[0];
}
