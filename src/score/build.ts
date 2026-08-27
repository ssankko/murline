// The Score build: one walk of OSMD's iterator turns a loaded sheet into Onsets, notes and the
// played timeline, and three short passes over the source measures add tempo, key and chords.

import {
  ChordSymbolContainer,
  MusicPartManagerIterator,
  type KeyInstruction,
  type MusicSheet,
  type Note as OsmdNote,
  type Staff as OsmdStaff,
} from 'opensheetmusicdisplay';
import { pitchClass } from '@/look/color';
import { analyzeHarmony } from './harmony';
import {
  ticksOf,
  type ChordSymbol,
  type KeyChange,
  type Measure,
  type Note,
  type Onset,
  type PlayStep,
  ScoreError,
  type Score,
  type TempoEntry,
} from './types';

// MuseScore's velocity per dynamics mark, in the order of OSMD's DynamicEnum: pppppp up to ffffff.
// The accent marks that follow them in the enum (sf, fp, rf) are not levels and never set one.
const VELOCITY = [16, 16, 16, 16, 33, 49, 64, 80, 96, 112, 126, 126, 126, 126];

/** Velocity of a note the score says nothing about. */
const DEFAULT_VELOCITY = 80;

/** A guard against a malformed repeat structure sending the iterator round for ever. */
const MAX_STEPS = 200_000;

/**
 * Builds the Score of the sheet's first part. Every staff of that part plays; the other parts are
 * read only for their count and are never sounded.
 */
export function buildScore(sheet: MusicSheet): Score {
  const instrument = sheet.Instruments[0];
  if (!instrument) throw new ScoreError('No notes in the first part', 'the sheet has no part');
  const staffIndexOf = new Map<OsmdStaff, number>(instrument.Staves.map((s, i) => [s, i]));
  const oneStaff = instrument.Staves.length < 2;

  const measures = measuresOf(sheet);
  const dynamics = dynamicsOf(sheet, instrument.Staves);

  const onsetByTick = new Map<number, Onset>();
  const steps: { tick: number; playedTick: number }[] = [];
  let totalTicks = 0;

  const it = new MusicPartManagerIterator(sheet);
  for (let guard = 0; !it.EndReached && guard < MAX_STEPS; guard++) {
    const tick = ticksOf(it.CurrentSourceTimestamp.RealValue);
    const playedTick = ticksOf(it.CurrentEnrolledTimestamp.RealValue);
    const measureIndex = it.CurrentMeasureIndex;
    const measure = measures[measureIndex];
    if (measure) {
      const measureStart = playedTick - ticksOf(it.CurrentRelativeInMeasureTimestamp.RealValue);
      totalTicks = Math.max(totalTicks, measureStart + measure.durationTicks);
    }

    let onset = onsetByTick.get(tick);
    if (!onset) {
      const notes: Note[] = [];
      for (const entry of it.CurrentVoiceEntries ?? []) {
        for (const source of entry.Notes) {
          const staff = staffIndexOf.get(source.ParentStaff);
          if (staff === undefined || !playable(source)) continue;
          const tiedFrom = !!source.NoteTie && source.NoteTie.StartNote !== source;
          notes.push({
            midi: source.Pitch.getHalfTone() + 12,
            staff,
            hand: oneStaff || staff === 0 ? 'right' : 'left',
            voice: entry.ParentVoice?.VoiceId ?? 1,
            onsetTick: tick,
            durationTicks: durationOf(source),
            tieStart: !!source.NoteTie && source.NoteTie.StartNote === source,
            tiedFrom,
            grace: source.IsGraceNote,
            strikeable: !tiedFrom,
            velocity: velocityAt(dynamics[staff], tick),
            measureIndex,
            source,
          });
        }
      }
      // A container of rests only is no moment of playing, so it becomes neither an Onset nor a step.
      if (notes.length === 0) {
        it.moveToNext();
        continue;
      }
      onset = { tick, measureIndex, notes, timestamp: it.CurrentSourceTimestamp.clone() };
      onsetByTick.set(tick, onset);
    }
    steps.push({ tick, playedTick });
    it.moveToNext();
  }

  const onsets = [...onsetByTick.values()].sort((a, b) => a.tick - b.tick);
  const indexOfTick = new Map(onsets.map((o, i) => [o.tick, i]));
  const playOrder: PlayStep[] = steps.map((s) => ({
    onsetIndex: indexOfTick.get(s.tick)!,
    tick: s.playedTick,
  }));

  const tempoMap = tempoMapOf(sheet);
  const score: Score = {
    title: sheet.TitleString ?? '',
    composer: sheet.ComposerString ?? '',
    partName: instrument.Name ?? '',
    partCount: sheet.Instruments.length,
    staffCount: instrument.Staves.length,
    onsets,
    playOrder,
    totalTicks,
    tempoMap,
    hasTempo: sheet.HasBPMInfo,
    constantTempo: tempoMap.length <= 1 && !hasContinuousTempo(sheet),
    hasDynamics: dynamics.some((marks) => marks.length > 0),
    measures,
    keys: keysOf(sheet),
    chords: chordsOf(sheet, instrument.Staves),
    harmony: [],
  };
  score.harmony = analyzeHarmony(score);
  return score;
}

/** Cue notes and notes the file hides are printed nowhere and played by nobody. */
function playable(note: OsmdNote): boolean {
  return !note.isRest() && !note.IsCueNote && note.PrintObject !== false && !!note.Pitch;
}

/** A tie sounds as one note, so its whole chain lands on the note that starts it. */
function durationOf(note: OsmdNote): number {
  if (note.IsGraceNote) return 0;
  const tie = note.NoteTie;
  if (tie && tie.StartNote === note) return ticksOf(tie.Duration.RealValue);
  return ticksOf(note.Length.RealValue);
}

function measuresOf(sheet: MusicSheet): Measure[] {
  return sheet.SourceMeasures.map((m, index) => ({
    index,
    number: m.MeasureNumber,
    startTick: ticksOf(m.AbsoluteTimestamp.RealValue),
    durationTicks: ticksOf(m.Duration.RealValue),
    beatsPerBar: m.ActiveTimeSignature?.Numerator ?? 4,
    beatUnit: m.ActiveTimeSignature?.Denominator ?? 4,
  }));
}

/** Dynamics marks per staff of the part, sorted by tick. Hairpins are not a level and are ignored. */
function dynamicsOf(sheet: MusicSheet, staves: OsmdStaff[]): { tick: number; velocity: number }[][] {
  const perStaff = staves.map(() => [] as { tick: number; velocity: number }[]);
  for (const measure of sheet.SourceMeasures) {
    staves.forEach((staff, index) => {
      for (const expression of measure.StaffLinkedExpressions[staff.idInMusicSheet] ?? []) {
        const velocity = VELOCITY[expression.InstantaneousDynamic?.DynEnum ?? -1];
        if (velocity === undefined) continue;
        perStaff[index]!.push({
          tick: ticksOf(expression.AbsoluteTimestamp.RealValue),
          velocity,
        });
      }
    });
  }
  for (const marks of perStaff) marks.sort((a, b) => a.tick - b.tick);
  return perStaff;
}

function velocityAt(marks: { tick: number; velocity: number }[] | undefined, tick: number): number {
  let velocity = DEFAULT_VELOCITY;
  for (const mark of marks ?? []) {
    if (mark.tick > tick) break;
    velocity = mark.velocity;
  }
  return velocity;
}

/**
 * Tempo in sheet time, one entry per change. OSMD fills every measure's `TempoInBPM` from the
 * metronome marks and `<sound tempo>` of the file, or with 120 where the file names no tempo at
 * all, which `hasTempo` is there to tell apart.
 */
// ponytail: a change lands on its bar line, not on the beat it is written over. Read the measure's
// TempoExpressions for the exact timestamp if a piece ever needs it.
function tempoMapOf(sheet: MusicSheet): TempoEntry[] {
  const entries: TempoEntry[] = [];
  for (const measure of sheet.SourceMeasures) {
    const bpm = measure.TempoInBPM;
    if (!(bpm > 0)) continue;
    const last = entries[entries.length - 1];
    if (last && last.bpm === bpm) continue;
    entries.push({ tick: ticksOf(measure.AbsoluteTimestamp.RealValue), bpm });
  }
  return entries.length > 0 ? entries : [{ tick: 0, bpm: 120 }];
}

/** A rit. or accel. means the tempo is not one number, whatever the marks say. */
function hasContinuousTempo(sheet: MusicSheet): boolean {
  return sheet.TimestampSortedTempoExpressionsList.some((e) => !!e.ContinuousTempo);
}

/** The file writes a key only where it changes, which is exactly what the Score keeps. */
function keysOf(sheet: MusicSheet): KeyChange[] {
  const keys: KeyChange[] = [];
  sheet.SourceMeasures.forEach((measure, index) => {
    const key = measure.getKeyInstruction(0);
    if (!key) return;
    const last = keys[keys.length - 1];
    if (last && last.sharps === key.Key && last.mode === key.Mode) return;
    keys.push({
      measureIndex: index,
      measureNumber: measure.MeasureNumber,
      sharps: key.Key,
      mode: key.Mode,
    });
  });
  return keys;
}

/** Chord symbols written in the file. Their text needs the engraving rules, so it is made now. */
function chordsOf(sheet: MusicSheet, staves: OsmdStaff[]): ChordSymbol[] {
  const ours = new Set(staves.map((s) => s.idInMusicSheet));
  const chords: ChordSymbol[] = [];
  let key: KeyInstruction | undefined;
  sheet.SourceMeasures.forEach((measure, index) => {
    key = measure.getKeyInstruction(0) ?? key;
    for (const container of measure.VerticalSourceStaffEntryContainers) {
      container.StaffEntries.forEach((entry, staffIndex) => {
        if (!entry || !ours.has(staffIndex)) return;
        for (const chord of entry.ChordContainers ?? []) {
          if (!chord?.RootPitch) continue;
          chords.push({
            tick: ticksOf(entry.AbsoluteTimestamp.RealValue),
            measureIndex: index,
            text: ChordSymbolContainer.calculateChordText(chord, 0, key!),
            root: pitchClass(chord.RootPitch.getHalfTone()),
            kind: chord.ChordKind,
            bass: chord.BassPitch ? pitchClass(chord.BassPitch.getHalfTone()) : undefined,
          });
        }
      });
    }
  });
  return chords.sort((a, b) => a.tick - b.tick);
}
