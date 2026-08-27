// The played notes of an engine seen as written noteheads: the sheet holds no state of its own, it
// only draws what this projection says the play has made of every head.

import type { NoteState } from '@/play/engine';
import type { Note } from '@/score/types';
import type { Note as OsmdNote } from 'opensheetmusicdisplay';

/** What a projection reads: the note states of a play, and the counter that says they moved. */
export interface Play {
  /** Bumped on every write to a note state, so a reader knows its projection is stale. */
  version: number;
  /** Every written note in played order, a repeated bar once per pass. */
  notes: readonly { note: Note; tick: number }[];
  noteState(index: number): NoteState;
}

/**
 * The state every written notehead shows. A note played several times shows its latest instance at
 * or before the clock, and a tie chain shows the state of the note that starts it, the only one
 * ever struck. A head the projection names is one the play has reached; every other head is pending.
 */
export function projectStates(
  notes: readonly { note: Note; tick: number }[],
  stateOf: (index: number) => NoteState,
  playedTick: number,
): Map<OsmdNote, NoteState> {
  const states = new Map<OsmdNote, NoteState>();
  for (let i = 0; i < notes.length; i++) {
    const { note, tick } = notes[i]!;
    // The notes run in played order, so the clock cuts the list and a later pass overwrites an
    // earlier one.
    if (tick > playedTick) break;
    if (note.tiedFrom) continue;
    const state = stateOf(i);
    for (const head of chainOf(note.source)) states.set(head, state);
  }
  return states;
}

/** The heads one struck note colours: its own, and the continuations of the tie it starts. */
function chainOf(source: OsmdNote): readonly OsmdNote[] {
  const tie = source.NoteTie;
  return tie?.StartNote === source ? tie.Notes : [source];
}
