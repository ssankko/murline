import type { NoteState } from '@/play/engine';
import type { Note } from '@/score/types';
import type { Note as OsmdNote } from 'opensheetmusicdisplay';
import { expect, test } from 'vitest';
import { projectStates } from './project';

/** An OSMD note with no tie on it, the identity of one written head. */
function head(): OsmdNote {
  return {} as OsmdNote;
}

/** Ties a run of heads into one chain, as OSMD does for a note held over a bar line. */
function tie(...heads: OsmdNote[]): void {
  const chain = { StartNote: heads[0]!, Notes: heads };
  for (const note of heads) (note as { NoteTie?: unknown }).NoteTie = chain;
}

function noteOf(source: OsmdNote, tiedFrom = false): Note {
  return {
    midi: 60,
    staff: 0,
    hand: 'right',
    onsetTick: 0,
    durationTicks: 960,
    tiedFrom,
    grace: false,
    strikeable: !tiedFrom,
    velocity: 80,
    measureIndex: 0,
    source,
  };
}

test('a tie chain shows the state of the note that starts it', () => {
  const [start, held] = [head(), head()];
  tie(start, held);
  const notes = [
    { note: noteOf(start), tick: 0, onsetTick: 0 },
    { note: noteOf(held, true), tick: 960, onsetTick: 960 },
  ];

  const states = projectStates(notes, () => 'miss', 1920);

  expect(states.get(start)).toBe('miss');
  expect(states.get(held)).toBe('miss');
});

test('a continuation of its own never overrides the state of the chain', () => {
  const [start, held] = [head(), head()];
  tie(start, held);
  const notes = [
    { note: noteOf(start), tick: 0, onsetTick: 0 },
    { note: noteOf(held, true), tick: 960, onsetTick: 960 },
  ];
  const state = (i: number): NoteState => (i === 0 ? 'hit' : 'pending');

  const states = projectStates(notes, state, 1920);

  expect(states.get(held)).toBe('hit');
});

test('a note played twice shows the latest instance the clock has reached', () => {
  const source = head();
  const notes = [
    { note: noteOf(source), tick: 0, onsetTick: 0 },
    { note: noteOf(source), tick: 1920, onsetTick: 1920 },
  ];
  const state = (i: number): NoteState => (i === 0 ? 'miss' : 'hit');

  expect(projectStates(notes, state, 1000).get(source)).toBe('miss');
  expect(projectStates(notes, state, 1920).get(source)).toBe('hit');
});

test('a note the clock has not reached is named by no state at all', () => {
  const source = head();
  const notes = [{ note: noteOf(source), tick: 960, onsetTick: 960 }];

  expect(projectStates(notes, () => 'miss', 0).has(source)).toBe(false);
});

test('a rolled note past the clock waits without holding back the Onset after it', () => {
  const [top, next] = [head(), head()];
  const notes = [
    { note: noteOf(top), tick: 360, onsetTick: 0 },
    { note: noteOf(next), tick: 240, onsetTick: 240 },
  ];

  const states = projectStates(notes, () => 'hit', 240);

  expect(states.has(top)).toBe(false);
  expect(states.get(next)).toBe('hit');
});
