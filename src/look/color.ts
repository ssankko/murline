// The one colour rule of the app: `colorOf` turns a MIDI number into the hex its notehead, its
// falling block and its key swatch are painted in. Every caller goes through it. The pitch-class
// helpers under it are the vocabulary the rest of the app names notes with.

export type Palette = 'muted' | 'full';

// Hue per pitch class, C red through B magenta. Each sharp sits on the hue midway between its
// neighbouring naturals, then drops in saturation and lightness so it never reads as its natural.
const HUES = [3, 20, 38, 55, 72, 135, 163, 190, 222, 253, 292, 330];
const IS_SHARP = [false, true, false, true, false, false, true, false, true, false, true, false];
const SHARP_S = -24;
const SHARP_L = -16;

// The muted tier every block and swatch wears, and the full tier a note reaching the now-line
// takes: the same hue at nearly all its saturation, so it reads as the pitch turned up.
const TONE: Record<Palette, { s: number; l: number }> = {
  muted: { s: 60, l: 50 },
  full: { s: 95, l: 46 },
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
  const pc = pitchClass(midi);
  const tone = TONE[palette];
  const sharp = IS_SHARP[pc]!;
  return hslHex(
    HUES[pc]!,
    tone.s + (sharp ? SHARP_S : 0),
    tone.l + (sharp ? SHARP_L : 0) + (dark ? DARK_LIFT : 0),
  );
}

/** Pitch class 0 to 11 of any semitone number, MIDI or OSMD half tone alike. */
export function pitchClass(semitones: number): number {
  return ((semitones % 12) + 12) % 12;
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(midi: number): string {
  return NOTE_NAMES[pitchClass(midi)] + (Math.floor(midi / 12) - 1);
}

export function isBlackKey(midi: number): boolean {
  return IS_SHARP[pitchClass(midi)]!;
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

/** Picks the light or dark member of one of the constants above. */
export function tone(pair: readonly [string, string], dark: boolean): string {
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
