// Harmony analysis: the chord names that run along the sheet. The piece is cut into segments by a
// scored search over the Onsets, and every segment gets an absolute name ("G7/B") and a degree name
// against the key in force ("5⁷/7"). A file that writes its own `<harmony>` symbols is not analysed
// at all; the symbols are the harmony.

import { AccidentalEnum, ChordSymbolEnum } from 'opensheetmusicdisplay';
import { beatOf } from './beat';
import { C_MAJOR, keyOf, type Key, type KeyAt } from './key';
import { pitchClass } from './pitch';
import {
  TICKS_PER_QUARTER,
  type ChordEvent,
  type ChordSymbol,
  type Measure,
  type Note,
  type Onset,
  type Score,
} from './types';

export interface Shape {
  /** Suffix of the absolute name. */
  abs: string;
  /** Suffix of the degree name. */
  rel: string;
  /** Semitones above the root. */
  steps: number[];
}

const MAJOR_TRIAD: Shape = { abs: '', rel: '', steps: [0, 4, 7] };
const MINOR_TRIAD: Shape = { abs: 'm', rel: 'm', steps: [0, 3, 7] };
const DIMINISHED: Shape = { abs: '°', rel: '°', steps: [0, 3, 6] };
const AUGMENTED: Shape = { abs: '+', rel: '+', steps: [0, 4, 8] };
const DOMINANT_7: Shape = { abs: '7', rel: '⁷', steps: [0, 4, 7, 10] };
const MAJOR_7: Shape = { abs: 'M7', rel: 'M⁷', steps: [0, 4, 7, 11] };
const MINOR_7: Shape = { abs: 'm7', rel: 'm⁷', steps: [0, 3, 7, 10] };
const HALF_DIMINISHED_7: Shape = { abs: 'ø7', rel: 'ø⁷', steps: [0, 3, 6, 10] };
const DIMINISHED_7: Shape = { abs: '°7', rel: '°⁷', steps: [0, 3, 6, 9] };
// The two sevenths only the harmonic minor stacks: on its tonic and on its mediant.
const MINOR_MAJOR_7: Shape = { abs: 'mM7', rel: 'mM⁷', steps: [0, 3, 7, 11] };
const AUGMENTED_MAJOR_7: Shape = {
  abs: '+M7',
  rel: '+M⁷',
  steps: [0, 4, 8, 11],
};

// Pardo's six templates plus the minor seventh, in the order of how often each labels a chord in
// his corpus, and the cost of picking each one: a fifth of the log2 ratio of its share to the major
// triad's. The diminished triad stands in for a rootless dominant seventh, so it costs about what
// that chord does; the minor seventh, under 2% of his corpus, costs as a share of 2% would. The
// major seventh is left out: it names every passing leading tone over a tonic.
const TEMPLATES: [Shape, number][] = [
  [MAJOR_TRIAD, 0],
  [DOMINANT_7, 0.2],
  [MINOR_TRIAD, 0.23],
  [DIMINISHED_7, 0.66],
  [HALF_DIMINISHED_7, 0.71],
  [DIMINISHED, 0.3],
  [MINOR_7, 0.9],
];

// Cost of a note off the template, per unit it sounds in: cheap when it steps to the next note of
// its staff, dear otherwise.
const ORNAMENT = 0.5;
const UNANCHORED = 3;

// Evidence a note on the template gives, by its semitones above the root: Temperley's root 5,
// fifth 3, major third 2, minor third 1, scaled to the root; a seventh counts little and a
// diminished seventh nothing.
const ROLE = [1, 0, 0, 0.2, 0.4, 0, 0.6, 0.6, 0.6, 0, 0.1, 0.1];

// Cost of a template tone with no note, by its semitones above the root: the root 1, a diminished
// fifth 0.8, any other tone 0.6.
const MISSING = [1, 0.6, 0.6, 0.6, 0.6, 0.6, 0.8, 0.6, 0.6, 0.6, 0.6, 0.6];

// Cost of starting a segment on a unit, in the units of the segment score (one note sounding in one
// unit): free at a bar line, cheap on a beat, dear elsewhere.
const CHANGE = { bar: 0, beat: 1, off: 3 };

/** A segment runs at most two bars, so one name never covers a phrase. */
const SEGMENT_BARS = 2;

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

const WHOLE_NOTE = 4 * TICKS_PER_QUARTER;

const pitchClasses = (notes: Note[]) => new Set(notes.map((n) => pitchClass(n.midi)));

/**
 * The chord events of a piece, one per Onset where the harmony changes. Empty for a piece with no
 * harmony to name at all.
 */
export function analyzeHarmony(score: Score): ChordEvent[] {
  return score.chords.length > 0 ? fromSymbols(score) : segment(score);
}

/** Sharps and flats of any depth fold to one sign; naturals and none are 0. */
function accidentalOf(note: Note): number {
  const accidental = note.source.Pitch.Accidental;
  if (accidental === AccidentalEnum.SHARP || accidental === AccidentalEnum.DOUBLESHARP) return 1;
  if (accidental === AccidentalEnum.FLAT || accidental === AccidentalEnum.DOUBLEFLAT) return -1;
  return 0;
}

/** Lexicographic comparison of two rank vectors, higher first. */
function beats(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

interface Candidate {
  root: number;
  shape: Shape;
  score: number;
}

/**
 * Best root and template for one segment: the evidence of the notes on the template, minus the
 * template tones with no note, minus the cost of the notes off it, minus the template's prior cost.
 * `weight` counts how many units each pitch class sounds in, `off` sums those units' off-template
 * cost, and `total` is that cost over the whole segment. Ties go to a complete template, then the
 * heavier root, then the commoner template.
 */
function scoreSegment(weight: number[], off: number[], total: number): Candidate {
  let best: (Candidate & { rank: number[] }) | undefined;
  TEMPLATES.forEach(([shape, prior], order) => {
    for (let root = 0; root < 12; root++) {
      let present = 0;
      let missing = 0;
      let onTemplate = 0;
      for (const step of shape.steps) {
        const tone = pitchClass(root + step);
        if (weight[tone]) {
          present += weight[tone]! * ROLE[step]!;
          onTemplate += off[tone]!;
        } else missing += MISSING[step]!;
      }
      const score = present - missing - (total - onTemplate) - prior;
      const rank = [score, missing === 0 ? 1 : 0, weight[root]!, -order];
      if (!best || beats(rank, best.rank)) best = { root, shape, score, rank };
    }
  });
  return best!;
}

/** The key in force at each key change, in sheet ticks. */
function keysOf(score: Score): KeyAt[] {
  const keys = score.keys.map((k) => ({
    tick: score.measures[k.measureIndex]?.startTick ?? 0,
    key: keyOf(k.sharps, k.mode),
  }));
  return keys.length > 0 ? keys : [{ tick: 0, key: C_MAJOR }];
}

/** Every beat start of the whole piece; a compound meter beats in dotted quarters. */
function beatStartsOf(measures: Measure[]): number[] {
  const beats: number[] = [];
  for (const measure of measures) {
    const length = beatOf(measure).ticks;
    for (let t = measure.startTick; t < measure.startTick + measure.durationTicks; t += length) {
      beats.push(t);
    }
  }
  return beats;
}

/**
 * A note is ornamental when a note of its own staff a step away follows within one beat of its
 * onset: it is passing melody, so it costs little where it lies off a template.
 */
function ornamentsOf(onsets: Onset[], beatLengthAt: (tick: number) => number): Set<Note> {
  const ornamental = new Set<Note>();
  onsets.forEach((onset, i) => {
    const until = onset.tick + beatLengthAt(onset.tick);
    for (const note of onset.notes) {
      for (let h = i + 1; h < onsets.length && onsets[h]!.tick <= until; h++) {
        const step = onsets[h]!.notes.some(
          (other) =>
            other.staff === note.staff &&
            other.midi !== note.midi &&
            Math.abs(other.midi - note.midi) <= 2,
        );
        if (step) {
          ornamental.add(note);
          break;
        }
      }
    }
  });
  return ornamental;
}

/**
 * The notes sounding at each Onset: the ones that start there plus the ones still ringing. A tie
 * continuation is the note that started the chain, which already rings for the whole of it, so only
 * the start note enters the ring set. A grace note has no length, so it sounds in no unit.
 */
function soundingOf(onsets: Onset[]): Note[][] {
  const sounding: Note[][] = [];
  const ringing: Note[] = [];
  for (const onset of onsets) {
    for (let i = ringing.length - 1; i >= 0; i--) {
      const note = ringing[i]!;
      if (note.onsetTick + note.durationTicks <= onset.tick) ringing.splice(i, 1);
    }
    ringing.push(...onset.notes.filter((n) => !n.tiedFrom && !n.grace));
    sounding.push([...ringing]);
  }
  return sounding;
}

/**
 * Cuts the piece into segments and names each one. A unit is one Onset lasting to the next; a
 * segment is a run of units under one template; the chosen segmentation maximises the sum of the
 * segment scores minus the change cost of each segment start, over segments of at most two bars.
 * A note counts in every unit it sounds in.
 */
function segment(score: Score): ChordEvent[] {
  const onsets = score.onsets;
  const n = onsets.length;
  if (n === 0) return [];

  const keys = keysOf(score);
  const beatStarts = beatStartsOf(score.measures);
  // How long the beat at a tick runs: to the next beat start, so a bar line cuts a ragged bar's
  // last beat short. Past the last beat start there is none, so a quarter stands in.
  const beatSpanAt = (tick: number) => {
    let i = -1;
    while (i + 1 < beatStarts.length && beatStarts[i + 1]! <= tick) i++;
    return i >= 0 && i + 1 < beatStarts.length
      ? beatStarts[i + 1]! - beatStarts[i]!
      : TICKS_PER_QUARTER;
  };

  const ticks = onsets.map((o) => o.tick);
  const lastEnd = Math.max(...onsets[n - 1]!.notes.map((x) => x.onsetTick + x.durationTicks));
  const endOf = (i: number) => (i + 1 < n ? ticks[i + 1]! : lastEnd);

  const barOf = (onset: Onset) => score.measures[onset.measureIndex];
  const ornamental = ornamentsOf(onsets, beatSpanAt);
  const sounding = soundingOf(onsets);
  const changeAt = onsets.map((o) => {
    const bar = barOf(o);
    if (!bar) return CHANGE.off;
    const into = o.tick - bar.startTick;
    return into === 0 ? CHANGE.bar : into % beatOf(bar).ticks === 0 ? CHANGE.beat : CHANGE.off;
  });
  const capAt = onsets.map((o) => SEGMENT_BARS * (barOf(o)?.durationTicks ?? WHOLE_NOTE));

  const best = [0, ...new Array<number>(n).fill(-Infinity)];
  const from = new Array<number>(n + 1).fill(0);
  const label = new Array<Candidate>(n + 1);
  for (let j = 1; j <= n; j++) {
    const weight = new Array<number>(12).fill(0);
    const off = new Array<number>(12).fill(0);
    let total = 0;
    // Shorter segments first, and a tie keeps the shorter one, so a name starts with its evidence.
    for (let i = j - 1; i >= 0 && (i === j - 1 || endOf(j - 1) - ticks[i]! <= capAt[i]!); i--) {
      for (const note of sounding[i]!) {
        const cost = ornamental.has(note) ? ORNAMENT : UNANCHORED;
        weight[pitchClass(note.midi)]!++;
        off[pitchClass(note.midi)]! += cost;
        total += cost;
      }
      const candidate = scoreSegment(weight, off, total);
      const reach = best[i]! + candidate.score - changeAt[i]!;
      if (reach > best[j]!) {
        best[j] = reach;
        from[j] = i;
        label[j] = candidate;
      }
    }
  }

  const cuts: [number, number][] = [];
  for (let j = n; j > 0; j = from[j]!) cuts.unshift([from[j]!, j]);

  const events: ChordEvent[] = [];
  let k = 0;
  for (const [i, j] of cuts) {
    while (k + 1 < keys.length && keys[k + 1]!.tick <= ticks[i]!) k++;
    const named = nameSegment(sounding.slice(i, j), label[j]!, keys[k]!.key);
    const last = events[events.length - 1];
    if (!named || (last && last.absolute === named.absolute && last.degree === named.degree)) {
      continue;
    }
    events.push({
      onsetIndex: i,
      tick: ticks[i]!,
      measureIndex: onsets[i]!.measureIndex,
      ...named,
    });
  }
  return events;
}

/**
 * The name of one segment. A diminished triad, or a half-diminished seventh on a chromatic root,
 * reads as the dominant seventh a major third below when that root is a degree of the key. A
 * diminished seventh is symmetric, so it is spelled from its bass. A bass that is the lowest pitch
 * class of every unit and a chord tone other than the root makes a slash name. A segment of one
 * pitch class, or of octave doublings only, is a line and not a harmony, so it carries the last
 * name.
 */
function nameSegment(
  units: Note[][],
  label: Candidate,
  key: Key,
): { absolute: string; degree: string; root: number; tones: number[] } | undefined {
  const notes = [...new Set(units.flat())];
  const line =
    pitchClasses(notes).size < 2 || units.every((u) => u.length >= 2 && pitchClasses(u).size === 1);
  if (line) return undefined;

  let { root, shape } = label;
  if (
    (shape === DIMINISHED || (shape === HALF_DIMINISHED_7 && !key.has(root))) &&
    key.has(pitchClass(root - 4))
  ) {
    root = pitchClass(root - 4);
    shape = DOMINANT_7;
  }
  // The bass is held when every unit has the same lowest pitch class, restruck or not.
  const lowestOf = (unit: Note[]) => pitchClass(Math.min(...unit.map((x) => x.midi)));
  const bass = lowestOf(units[0]!);
  const held = units.every((u) => lowestOf(u) === bass);
  if (shape === DIMINISHED_7 && held && shape.steps.some((st) => pitchClass(root + st) === bass)) {
    root = bass;
  }

  const tones = shape.steps.map((st) => pitchClass(root + st));
  const slash = bass !== root && tones.includes(bass) && held;
  const written = (p: number) => {
    const note = notes.find((x) => pitchClass(x.midi) === p);
    return note ? accidentalOf(note) : 0;
  };
  return {
    absolute:
      key.spell(root, written(root)) +
      shape.abs +
      (slash ? `/${key.spell(bass, written(bass))}` : ''),
    degree:
      key.degreeOf(root, written(root)) +
      shape.rel +
      (slash ? `/${key.degreeOf(bass, written(bass))}` : ''),
    root,
    tones,
  };
}

// The template every `<harmony>` kind with a base quality stands on, for its degree suffix and its
// tones. A ninth, an eleventh and a thirteenth stand on the seventh they are built on. Every other
// kind reads "?": the sus kinds, the added-note kinds (the sixths) and the augmented sixths name no
// template.
const KIND_SHAPE = new Map<ChordSymbolEnum, Shape>([
  [ChordSymbolEnum.major, MAJOR_TRIAD],
  [ChordSymbolEnum.minor, MINOR_TRIAD],
  [ChordSymbolEnum.augmented, AUGMENTED],
  [ChordSymbolEnum.diminished, DIMINISHED],
  [ChordSymbolEnum.dominant, DOMINANT_7],
  [ChordSymbolEnum.majorseventh, MAJOR_7],
  [ChordSymbolEnum.minorseventh, MINOR_7],
  [ChordSymbolEnum.diminishedseventh, DIMINISHED_7],
  [ChordSymbolEnum.augmentedseventh, AUGMENTED],
  [ChordSymbolEnum.halfdiminished, HALF_DIMINISHED_7],
  [ChordSymbolEnum.majorminor, MINOR_TRIAD],
  [ChordSymbolEnum.dominantninth, DOMINANT_7],
  [ChordSymbolEnum.majorninth, MAJOR_7],
  [ChordSymbolEnum.minorninth, MINOR_7],
  [ChordSymbolEnum.dominant11th, DOMINANT_7],
  [ChordSymbolEnum.major11th, MAJOR_7],
  [ChordSymbolEnum.minor11th, MINOR_7],
  [ChordSymbolEnum.dominant13th, DOMINANT_7],
  [ChordSymbolEnum.major13th, MAJOR_7],
  [ChordSymbolEnum.minor13th, MINOR_7],
  [ChordSymbolEnum.Neapolitan, MAJOR_TRIAD],
]);

const UNNAMEABLE_DEGREE = '?';

/**
 * The harmony of a file that writes its own chord symbols. The absolute name is the symbol as it is
 * printed; the degree name comes from its root, kind and bass against the key in force.
 */
function fromSymbols(score: Score): ChordEvent[] {
  const keys = keysOf(score);
  const events: ChordEvent[] = [];
  for (const symbol of score.chords) {
    const key = keys.findLast((k) => k.tick <= symbol.tick)?.key ?? C_MAJOR;
    const shape = KIND_SHAPE.get(symbol.kind);
    const named = {
      absolute: symbol.text,
      degree: degreeOfSymbol(symbol, key),
      root: symbol.root,
      // A kind that names no template stands on its root alone, and a slash bass is a tone only
      // where the template already holds it.
      tones: (shape?.steps ?? [0]).map((st) => pitchClass(symbol.root + st)),
    };
    const last = events[events.length - 1];
    if (last && last.absolute === named.absolute && last.degree === named.degree) continue;
    // The symbol is written over the note it starts on, so it belongs to the next Onset.
    const found = score.onsets.findIndex((o) => o.tick >= symbol.tick);
    const at = found === -1 ? score.onsets.length - 1 : found;
    const onset = score.onsets[at];
    if (!onset) continue;
    const event = {
      onsetIndex: at,
      tick: onset.tick,
      measureIndex: onset.measureIndex,
      ...named,
    };
    // Two symbols over one Onset are one beat, and the later one is what is heard there.
    if (last && last.onsetIndex === at) events[events.length - 1] = event;
    else events.push(event);
  }
  return events;
}

/** A written symbol has no accidental of its own, so the key alone decides its spelling. */
function degreeOfSymbol(symbol: ChordSymbol, key: Key): string {
  const shape = KIND_SHAPE.get(symbol.kind);
  if (!shape) return UNNAMEABLE_DEGREE;
  const slash =
    symbol.bass !== undefined && symbol.bass !== symbol.root
      ? `/${key.degreeOf(symbol.bass, 0)}`
      : '';
  return key.degreeOf(symbol.root, 0) + shape.rel + slash;
}
