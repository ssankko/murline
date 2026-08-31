// Preview playback's note list: the Score as the sound engine wants it, in seconds along the
// played timeline. Repeats are expanded through `playOrder`, so a bar that comes round again is a
// second set of notes at a later second. Nothing here talks to Rust; the Preview screen does.

import { clamp } from '@/lib/utils';
import { TICKS_PER_QUARTER, bpmAt, stepSeconds, type Score } from '@/score/types';

/** One note as the engine schedules it. Times are the score's own seconds, tempo percent aside. */
export interface PreviewNote {
  midi: number;
  /** From the note's dynamics mark, 80 where the score writes none. */
  velocity: number;
  on: number;
  off: number;
}

/** The second a played tick falls on, read on from the step at `from`. */
function secondsAt(score: Score, starts: number[], playedTick: number, from: number): number {
  let i = from;
  while (i + 1 < score.playOrder.length && score.playOrder[i + 1]!.tick <= playedTick) i++;
  const step = score.playOrder[i]!;
  const bpm = bpmAt(score, score.onsets[step.onsetIndex]!.tick);
  const start = i === 0 ? 0 : step.tick;
  return starts[i]! + ((playedTick - start) / TICKS_PER_QUARTER) * (60 / bpm);
}

/** Every note of both hands in played order, at the score's own tempo. */
export function previewNotes(score: Score): PreviewNote[] {
  const starts = stepSeconds(score);
  const notes: PreviewNote[] = [];
  score.playOrder.forEach((step, i) => {
    for (const note of score.onsets[step.onsetIndex]!.notes) {
      // A grace note has no length of its own, and a tie continuation is already sounding: the
      // note that starts the chain carries the whole of it.
      if (note.grace || note.tiedFrom) continue;
      notes.push({
        midi: note.midi,
        velocity: note.velocity,
        on: starts[i]!,
        off: secondsAt(score, starts, step.tick + note.durationTicks, i),
      });
    }
  });
  return notes;
}

/** The played tick the engine's clock stands at, read back from the seconds it reports. */
export function tickAt(score: Score, starts: number[], seconds: number): number {
  const last = score.playOrder.length - 1;
  if (last < 0) return 0;
  let i = 0;
  while (i < last && starts[i + 1]! <= seconds) i++;
  const step = score.playOrder[i]!;
  const bpm = bpmAt(score, score.onsets[step.onsetIndex]!.tick);
  const start = i === 0 ? 0 : step.tick;
  const tick = start + ((seconds - starts[i]!) * bpm * TICKS_PER_QUARTER) / 60;
  return clamp(tick, 0, score.totalTicks);
}

/** The second a played tick falls on, which is what a seek to it asks the engine for. */
export function secondsOf(score: Score, starts: number[], playedTick: number): number {
  if (score.playOrder.length === 0) return 0;
  return secondsAt(score, starts, playedTick, 0);
}
