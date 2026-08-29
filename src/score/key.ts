// The key in force at a point of the score: the sharps or flats its signature carries and its mode,
// and everything a caller reads off it: its tonic, its scale, the spelled notes, its name, its
// signature, its degree table and the keys related to it.

import { SEVENTHS, TRIADS, type Shape } from './harmony';
import { FLAT_NAMES, SHARP_NAMES, pitchClass } from './pitch';

/** One scale degree of a key: what it is called and what it stacks into. */
export interface KeyDegree {
  degree: number;
  note: string;
  /** The note as semitones from C, for its colour. */
  pitch: number;
  role: string;
  triad: string;
  /** The triad's notes, spelled by letter: "D F♯ A". */
  notes: string;
  seventh: string;
}

export interface Key {
  /** Sharps positive, flats negative. */
  readonly sharps: number;
  /** OSMD's KeyEnum; read it through `major` or `modeName`. */
  readonly mode: number;
  /** Tonic pitch class. */
  readonly tonic: number;
  /** A major mode; every other mode is read against the harmonic minor. */
  readonly major: boolean;
  /** The seven pitch classes of the scale, tonic first. */
  readonly pcs: number[];
  /** The scale spelled by letter, one letter each, tonic first: "D", "E", "F♯", ... */
  readonly names: string[];
  /** "D major", "F♯ minor", "C♭ major". */
  readonly name: string;
  /** How many sharps or flats the signature holds, which sign, and the notes they fall on in order. */
  readonly signature: { count: number; sign: '♯' | '♭'; notes: string[] };
  /** The key sharing this one's signature: the relative minor of a major key, or the other way. */
  readonly relative: Key;
  /** The key on this one's tonic in the other mode. */
  readonly parallel: Key;
  /** The key laid out one entry per scale degree. */
  readonly table: KeyDegree[];
  /** Whether the pitch class is a note of the scale. */
  has(pc: number): boolean;
  /**
   * Scale degree of a pitch class: "5", "♭7", "♯4". `written` is the note's own accidental, 1 for a
   * sharp, -1 for a flat, 0 for none or a natural.
   */
  degreeOf(pc: number, written: number): string;
  /** Note name of a pitch class: flats when the note or the key is written with them. */
  spell(pc: number, written: number): string;
}

/** The key in force from a sheet tick on. */
export interface KeyAt {
  tick: number;
  key: Key;
}

/** OSMD's `KeyEnum` in the order of its members. */
const KEY_MODES = [
  'major',
  'minor',
  'none',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'aeolian',
  'ionian',
  'locrian',
] as const;

export type KeyMode = (typeof KEY_MODES)[number];

/** The name of a mode number; one OSMD does not list reads as major. */
export const modeName = (mode: number): KeyMode => KEY_MODES[mode] ?? 'major';

/** The mode number of a name; one OSMD does not list reads as major. */
export const modeOf = (name: string): number => Math.max(0, KEY_MODES.indexOf(name as KeyMode));

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const HARMONIC_MINOR = [0, 2, 3, 5, 7, 8, 11];
// Semitones from the key signature's major tonic to the mode's tonic, indexed by OSMD's KeyEnum.
const MODE_OFFSET = [0, 9, 0, 2, 4, 5, 7, 9, 0, 11];
const MAJOR_MODES = new Set([0, 2, 8]);
/** The note letters, the pitch class each one is natural at, and the accidentals from -2 to 2. */
const LETTERS = 'CDEFGAB';
const LETTER_PCS = [0, 2, 4, 5, 7, 9, 11];
const ACCIDENTALS = ['♭♭', '♭', '', '♯', '♯♯'];
/** The letters a key signature takes its sharps on, in order; flats take them in reverse. */
const SIGNATURE_ORDER = [3, 0, 4, 1, 5, 2, 6];
/** What each scale degree does in the key. */
const ROLES = [
  'tonic',
  'supertonic',
  'mediant',
  'subdominant',
  'dominant',
  'submediant',
  'leading tone',
];

const keys = new Map<string, Key>();

/** The key of a signature and a mode. The same pair is the same object, so keys compare by identity. */
export function keyOf(sharps: number, mode: number): Key {
  const id = `${sharps}/${mode}`;
  let key = keys.get(id);
  if (!key) keys.set(id, (key = build(sharps, mode)));
  return key;
}

/** The key a piece with no key signature is read in. */
export const C_MAJOR = keyOf(0, 0);

function build(sharps: number, mode: number): Key {
  const major = MAJOR_MODES.has(mode);
  // The key signature's major tonic, moved by the mode.
  const tonic = pitchClass(sharps * 7 + (MODE_OFFSET[mode] ?? 0));
  const scale = major ? MAJOR_SCALE : HARMONIC_MINOR;
  const pcs = scale.map((step) => pitchClass(tonic + step));
  // Letter of the tonic: four letters up per sharp, five more for a minor key.
  const majorLetter = (((sharps * 4) % 7) + 7) % 7;
  const letter = major ? majorLetter : (majorLetter + 5) % 7;
  const names = pcs.map((pc, i) => spellOn((letter + i) % 7, pc));
  let table: KeyDegree[] | undefined;
  return {
    sharps,
    mode,
    tonic,
    major,
    pcs,
    names,
    name: `${spellOn(letter, tonic)} ${major ? 'major' : 'minor'}`,
    signature: signatureOf(sharps),
    get relative() {
      return keyOf(sharps, major ? 1 : 0);
    },
    // A minor key signs three sharps fewer.
    get parallel() {
      return keyOf(sharps + (major ? -3 : 3), major ? 1 : 0);
    },
    // Built on first read: its shapes come from harmony.ts, which imports this module, so neither
    // needs the other while it loads.
    get table() {
      return (table ??= tableOf(scale, names, tonic));
    },
    has: (pc) => pcs.includes(pitchClass(pc)),
    degreeOf(pc, written) {
      const step = pitchClass(pc - tonic);
      const own = scale.indexOf(step);
      if (own >= 0) return String(own + 1);
      const below = scale.indexOf(pitchClass(step - 1));
      const above = scale.indexOf(pitchClass(step + 1));
      // Both neighbours a semitone away: a written sharp raises the lower degree, a written flat
      // lowers the upper one, and a natural undoes the key signature's own accidental.
      const sharp = below >= 0 && (above < 0 || (written === 0 ? sharps < 0 : written > 0));
      return sharp ? `♯${below + 1}` : `♭${above + 1}`;
    },
    spell(pc, written) {
      const flat = written < 0 || (written === 0 && sharps < 0);
      return (flat ? FLAT_NAMES : SHARP_NAMES)[pc]!;
    },
  };
}

/**
 * A pitch class written on one letter: the accidental is how far the pitch stands from the letter's
 * natural, so B on the letter C reads "C♭" and G♯ on the letter G reads "G♯".
 */
function spellOn(letter: number, pc: number): string {
  const away = ((pitchClass(pc - LETTER_PCS[letter]!) + 6) % 12) - 6;
  return LETTERS[letter]! + (ACCIDENTALS[away + 2] ?? '');
}

function signatureOf(sharps: number): Key['signature'] {
  const count = Math.abs(sharps);
  const order = sharps < 0 ? [...SIGNATURE_ORDER].reverse() : SIGNATURE_ORDER;
  const sign = sharps < 0 ? '♭' : '♯';
  return { count, sign, notes: order.slice(0, count).map((letter) => LETTERS[letter]! + sign) };
}

/**
 * The chords come from stacking the scale degrees i, i+2, i+4 and i+6 and matching the semitones
 * above the root against the shapes.
 */
function tableOf(scale: number[], names: string[], tonic: number): KeyDegree[] {
  return names.map((note, i) => {
    const stack = [2, 4, 6].map((n) => pitchClass(scale[(i + n) % 7]! - scale[i]!));
    const match = (shapes: Shape[], size: number) =>
      shapes.find((each) => each.steps.slice(1, size).every((step, k) => step === stack[k]));
    const triad = match(TRIADS, 3) ?? TRIADS[0]!;
    const seventh = match(SEVENTHS, 4) ?? SEVENTHS[0]!;
    return {
      degree: i + 1,
      note,
      pitch: tonic + scale[i]!,
      role: ROLES[i]!,
      triad: note + triad.abs,
      notes: [0, 2, 4].map((n) => names[(i + n) % 7]!).join(' '),
      seventh: note + seventh.abs,
    };
  });
}
