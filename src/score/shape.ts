// The chord shapes the app knows: a stack of semitones above a root, with the suffix each one puts
// on an absolute name and on a degree name. The harmony matches its segments against them and a key
// stacks its scale degrees into them.

export interface Shape {
  /** Suffix of the absolute name. */
  abs: string;
  /** Suffix of the degree name; a shape the degree form cannot read has none. */
  rel?: string | undefined;
  /** Semitones above the root. */
  steps: number[];
}

export const MAJOR_TRIAD: Shape = { abs: '', rel: '', steps: [0, 4, 7] };
export const MINOR_TRIAD: Shape = { abs: 'm', rel: 'm', steps: [0, 3, 7] };
export const DIMINISHED: Shape = { abs: '°', rel: '°', steps: [0, 3, 6] };
export const AUGMENTED: Shape = { abs: '+', rel: '+', steps: [0, 4, 8] };
export const DOMINANT_7: Shape = { abs: '7', rel: '⁷', steps: [0, 4, 7, 10] };
export const MAJOR_7: Shape = { abs: 'M7', rel: 'M⁷', steps: [0, 4, 7, 11] };
export const MINOR_7: Shape = { abs: 'm7', rel: 'm⁷', steps: [0, 3, 7, 10] };
export const HALF_DIMINISHED_7: Shape = { abs: 'ø7', rel: 'ø⁷', steps: [0, 3, 6, 10] };
export const DIMINISHED_7: Shape = { abs: '°7', rel: '°⁷', steps: [0, 3, 6, 9] };
// The two sevenths only the harmonic minor stacks: on its tonic and on its mediant.
const MINOR_MAJOR_7: Shape = { abs: 'mM7', rel: 'mM⁷', steps: [0, 3, 7, 11] };
const AUGMENTED_MAJOR_7: Shape = { abs: '+M7', rel: '+M⁷', steps: [0, 4, 8, 11] };

/** The triads a scale degree can stack into. */
export const TRIADS = [MAJOR_TRIAD, MINOR_TRIAD, DIMINISHED, AUGMENTED];
/** The sevenths a scale degree can stack into, over the major scale and the harmonic minor. */
export const SEVENTHS = [
  MAJOR_7,
  MINOR_7,
  DOMINANT_7,
  HALF_DIMINISHED_7,
  DIMINISHED_7,
  MINOR_MAJOR_7,
  AUGMENTED_MAJOR_7,
];
