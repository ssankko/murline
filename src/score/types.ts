// The Score: what one MusicXML file means to the app. Built fresh from OSMD every time a piece
// opens, never stored. Everything in it is integer ticks; the OSMD objects it keeps are the bridge
// back to the drawn sheet.

import type { Note as OsmdNote } from 'opensheetmusicdisplay';

/** Time unit of the whole app. A quarter note is 960 ticks, so triplets and 64ths stay integers. */
export const TICKS_PER_QUARTER = 960;

/** Whole notes (OSMD's `Fraction.RealValue`) to ticks. */
export function ticksOf(wholeNotes: number): number {
  return Math.round(wholeNotes * 4 * TICKS_PER_QUARTER);
}

export type Hand = 'left' | 'right';

/** One written note of the first part. Rests are not Notes; they only shape the Onsets. */
export interface Note {
  midi: number;
  /** Staff inside the part: 0 is the upper one. */
  staff: number;
  /** Staff 0 is the right hand, staff 1 the left; a one-staff part is all right hand. */
  hand: Hand;
  /** Sheet tick, the same value on every pass of a repeat. */
  onsetTick: number;
  /** The whole tie chain on the note that starts it, the written length otherwise; 0 for a grace. */
  durationTicks: number;
  /** A tie continuation: it sounds on from the previous note and is never struck. */
  tiedFrom: boolean;
  grace: boolean;
  /** The user is expected to press this key at this Onset. */
  strikeable: boolean;
  /** Ideal MIDI velocity from the dynamics marks, 80 where the score has none. */
  velocity: number;
  measureIndex: number;
  /** The OSMD note, the identity that finds this note's SVG after any render. */
  source: OsmdNote;
}

/** One moment of the printed sheet at which at least one note starts. */
export interface Onset {
  /** Sheet tick from the start of the piece, repeats not expanded. */
  tick: number;
  measureIndex: number;
  notes: Note[];
}

/** One step of the played timeline: which Onset sounds, and when in played time. */
export interface PlayStep {
  onsetIndex: number;
  /** Played tick: a repeated bar comes round again at a later tick. */
  tick: number;
}

/** A tempo mark, keyed by sheet tick because a repeated bar keeps its tempo. */
export interface TempoEntry {
  tick: number;
  bpm: number;
}

export interface Measure {
  index: number;
  /** Printed bar number; a pickup measure is 0. */
  number: number;
  /** Sheet tick of the bar line that opens the measure. */
  startTick: number;
  durationTicks: number;
  beatsPerBar: number;
  /** Denominator of the time signature: 4 for a quarter, 8 for an eighth. */
  beatUnit: number;
}

/** A key signature, listed only at the measures where it changes. */
export interface KeyChange {
  measureIndex: number;
  /** Positive for sharps, negative for flats. */
  sharps: number;
  /** OSMD's `KeyEnum`: 0 major, 1 minor, and the church modes above. */
  mode: number;
}

/** A `<harmony>` symbol written in the file. */
export interface ChordSymbol {
  tick: number;
  measureIndex: number;
  /** As OSMD would print it, for example "Cmaj7/E". */
  text: string;
  /** Pitch class 0 to 11. */
  root: number;
  /** OSMD's `ChordSymbolEnum`. */
  kind: number;
  /** Pitch class of the printed bass note, undefined without a slash. */
  bass?: number;
}

/**
 * One chord of the harmony display, at the Onset where the harmony changes. `absolute` is the name
 * as a musician writes it ("G7/B"); `degree` is the same chord against the key in force ("5⁷/7").
 */
export interface ChordEvent {
  onsetIndex: number;
  /** Sheet tick of the Onset, so a repeated bar carries the chord again. */
  tick: number;
  measureIndex: number;
  absolute: string;
  degree: string;
}

export interface Score {
  title: string;
  composer: string;
  /** The first part's name; the app plays no other part. */
  partName: string;
  partCount: number;
  staffCount: number;
  onsets: Onset[];
  playOrder: PlayStep[];
  /** Played length of the piece, to the last bar line. */
  totalTicks: number;
  tempoMap: TempoEntry[];
  /** False when the file names no tempo, which is what makes the play default to 120 BPM. */
  hasTempo: boolean;
  /** One tempo for the whole piece, which is what allows BPM mode. */
  constantTempo: boolean;
  /** False when the file writes no dynamics mark, which is what drops velocity out of a Grade. */
  hasDynamics: boolean;
  measures: Measure[];
  keys: KeyChange[];
  chords: ChordSymbol[];
  /**
   * The chord names along the sheet, one per Onset where the harmony changes. Empty until the
   * sheet analyses it.
   */
  harmony: ChordEvent[];
}

/** The tempo in force at a sheet tick. The first entry also covers everything before it. */
export function bpmAt(score: Score, tick: number): number {
  let bpm = score.tempoMap[0]?.bpm ?? 120;
  for (const entry of score.tempoMap) {
    if (entry.tick > tick) break;
    bpm = entry.bpm;
  }
  return bpm;
}

/** How long the piece sounds at its written tempo, following the repeats. */
export function playedSeconds(score: Score): number {
  let seconds = 0;
  for (let i = 0; i < score.playOrder.length; i++) {
    const step = score.playOrder[i]!;
    const from = i === 0 ? 0 : step.tick;
    const to = score.playOrder[i + 1]?.tick ?? score.totalTicks;
    const bpm = bpmAt(score, score.onsets[step.onsetIndex]!.tick);
    seconds += ((to - from) / TICKS_PER_QUARTER) * (60 / bpm);
  }
  return seconds;
}

/** The four reasons a piece can carry; the raw message follows in `detail`. */
export type ScoreErrorReason =
  | 'Not a MusicXML file'
  | 'Could not read the file'
  | 'No notes in the first part'
  | 'File not found';

export class ScoreError extends Error {
  readonly reason: ScoreErrorReason;
  readonly detail: string;

  constructor(reason: ScoreErrorReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'ScoreError';
    this.reason = reason;
    this.detail = detail;
  }
}
