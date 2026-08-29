// The pitch vocabulary the whole app names notes with: the pitch class of a semitone number, the
// octave and name of a MIDI number, and the two spelling tables. One glyph rule holds everywhere:
// an accidental is written ♯ or ♭, never # or b.

/** Pitch class 0 to 11 of any semitone number, MIDI or OSMD half tone alike. */
export function pitchClass(semitones: number): number {
  return ((semitones % 12) + 12) % 12;
}

/** The twelve pitch classes spelled with sharps, and the same twelve spelled with flats. */
export const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

/** The octave a MIDI number stands in, middle C being C4. */
export function octave(midi: number): number {
  return Math.floor(midi / 12) - 1;
}

/** A MIDI number with its octave, spelled with sharps: "C4", "A♯0". */
export function noteName(midi: number): string {
  return SHARP_NAMES[pitchClass(midi)]! + octave(midi);
}

/** A note off the white keys, which is one the sharp spelling gives an accidental to. */
export function isBlackKey(midi: number): boolean {
  return SHARP_NAMES[pitchClass(midi)]!.length > 1;
}

/** The twelve pitch classes a fifth apart, C first. */
export const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
