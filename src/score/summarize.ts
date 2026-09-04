// The index: the handful of facts the library page shows, taken from a built Score and stored in
// the `piece` row so the page never opens a file.

import { keyAt, modeName, type KeyMode } from './key';
import { bpmAt, playedSeconds, ScoreError, type Score } from './types';

/** What OSMD titles a sheet that names no work: a Blob carries no file name to fall back on. */
const NO_TITLE = 'Untitled Score';

export interface PieceIndex {
  title: string;
  composer: string;
  measureCount: number;
  durationS: number;
  midiLo: number;
  midiHi: number;
  hasTempo: boolean;
  constantTempo: boolean;
  /** The first tempo mark's BPM, null where the file names no tempo. */
  tempoBpm: number | null;
  keySharps: number;
  keyMode: KeyMode;
  partCount: number;
  partName: string;
}

/**
 * Summarises a Score for the library. The file name stands in for a title or a composer the file
 * leaves empty. A Score nobody can play is an indexing failure, not an empty row.
 */
export function summarize(score: Score, fileName: string): PieceIndex {
  let midiLo = Infinity;
  let midiHi = -Infinity;
  let strikeable = 0;
  for (const onset of score.onsets) {
    for (const note of onset.notes) {
      midiLo = Math.min(midiLo, note.midi);
      midiHi = Math.max(midiHi, note.midi);
      if (note.strikeable) strikeable++;
    }
  }
  if (strikeable === 0) {
    throw new ScoreError('No notes in the first part', `${fileName} has nothing to play`);
  }

  // The key the piece opens in, which the library filters on.
  const key = keyAt(score, 0);
  const title = score.title.trim();
  return {
    title: (title === NO_TITLE ? '' : title) || baseName(fileName),
    composer: score.composer.trim() || baseName(fileName),
    measureCount: score.measures.length,
    durationS: playedSeconds(score),
    midiLo,
    midiHi,
    hasTempo: score.hasTempo,
    constantTempo: score.constantTempo,
    tempoBpm: score.hasTempo ? bpmAt(score, 0) : null,
    keySharps: key.sharps,
    keyMode: modeName(key.mode),
    partCount: score.partCount,
    partName: score.partName.trim() || 'Part 1',
  };
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}
