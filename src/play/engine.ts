// The play engine: the clock of one play and where it stands in the Score. Pure TypeScript, no
// DOM, no React, no timer of its own. The screen owns the frame loop and feeds it wall time.

import type { PlaySettings } from '@/play/settings';
import { TICKS_PER_QUARTER, bpmAt, type Hand, type Note, type Score } from '@/score/types';

/** Where a play stands. A Wait mode stop is the clock standing still inside `running`. */
export type PlayState = 'idle' | 'counting-in' | 'running' | 'paused' | 'ended';

/** A practice may pause, seek and change settings; a performance may not and is graded. */
export type PlayKind = 'practice' | 'performance';

/** One MIDI key going down or coming up, as the engine will match it. */
export interface StrikeEvent {
  midi: number;
  velocity: number;
  /** Wall-clock milliseconds, stamped where the event entered the app. */
  time: number;
  on: boolean;
}

/** What one strike turned out to be, and what an expected note running out of window turns into. */
export type Verdict = 'hit' | 'extra' | 'miss' | 'absorbed';

/** One thing that happened since the last frame. The screen drains them with `events()`. */
export interface PlayEvent {
  verdict: Verdict;
  midi: number;
  /** Index into `notes` for a hit or a miss, -1 for an extra or an absorbed strike. */
  noteIndex: number;
  /** Wall-clock milliseconds: the strike's own timestamp, or the frame that closed the window. */
  time: number;
}

/** One written note laid out in played time: what falls in the lane and what a strike may match. */
export interface PlayNote {
  midi: number;
  /** Played tick of the Onset it starts at, so a repeated bar carries it again later. */
  tick: number;
  durationTicks: number;
  hand: Hand;
  grace: boolean;
  measureIndex: number;
  /** The written note, the identity the sheet marks. */
  note: Note;
}

/** How a note reads in the lane. */
export type NoteState = 'pending' | 'hit' | 'miss';

/** How a key reads on the keyboard: its pitch colour, grey while held wrong, or unheld. */
export type KeyState = 'base' | 'grey' | 'color';

/** Everything a frame needs to draw. Read once per frame; never held across frames. */
export interface Snapshot {
  state: PlayState;
  kind: PlayKind;
  /** The clock, in played ticks: a repeated bar comes round again at a later tick. */
  playedTick: number;
  /** Index into `score.playOrder`, which names both the Onset and the pass it belongs to. */
  stepIndex: number;
  onsetIndex: number;
  measureIndex: number;
}

/** The tempo the piece is written at, before the play's own tempo setting. */
function writtenBpm(score: Score, sheetTick: number): number {
  return score.hasTempo ? bpmAt(score, sheetTick) : 120;
}

export class Engine {
  readonly score: Score;
  /** The live settings of the play. A change to them applies from the next `advance`. */
  readonly settings: PlaySettings;
  /** Every written note in played order: the lane draws these and a strike matches one of them. */
  readonly notes: PlayNote[];
  kind: PlayKind = 'practice';

  private state: PlayState = 'idle';
  private tick = 0;
  /** Played tick the play parks at when Idle, and returns to on restart. */
  private startTick = 0;
  private readonly lastSoundingTick: number;

  /** Wall-clock milliseconds of the last `advance`: what a strike's timestamp is measured against. */
  private wall = 0;
  private states: NoteState[];
  /** Wall-clock time each note became a hit or a miss, which is what the feedback fades from. */
  private resolved: number[];
  /** Keys down now: pitch to the note its strike matched, -1 when it matched nothing. */
  private readonly held = new Map<number, number>();
  private pending: PlayEvent[] = [];
  /** First note whose matching window is still open; everything before it is settled. */
  private closed = 0;

  constructor(score: Score, settings: PlaySettings) {
    this.score = score;
    this.settings = settings;
    this.lastSoundingTick = lastSoundingTickOf(score);
    this.notes = playNotesOf(score);
    this.states = this.notes.map(() => 'pending');
    this.resolved = this.notes.map(() => 0);
  }

  noteState(index: number): NoteState {
    return this.states[index] ?? 'pending';
  }

  /** Wall-clock time the note was settled at; 0 while it is pending. */
  resolvedAt(index: number): number {
    return this.resolved[index] ?? 0;
  }

  /** The key colour rule: colour only while the strike matched a note that is still sounding. */
  keyState(midi: number): KeyState {
    const matched = this.held.get(midi);
    if (matched === undefined) return 'base';
    if (matched < 0) return 'grey';
    const note = this.notes[matched]!;
    return this.tick < note.tick + note.durationTicks ? 'color' : 'grey';
  }

  /** Takes everything that happened since the last call. Nothing is kept for a second reader. */
  events(): PlayEvent[] {
    if (this.pending.length === 0) return EMPTY_EVENTS;
    const events = this.pending;
    this.pending = [];
    return events;
  }

  /** Played tick the play stops at: the last written duration plus the matching window. */
  get endTick(): number {
    return this.lastSoundingTick + this.msToTicks(this.settings.matchingWindowMs, this.lastSoundingTick);
  }

  /** The matching window in played ticks, at the tempo the clock runs now. */
  get windowTicks(): number {
    return this.msToTicks(this.settings.matchingWindowMs, this.tick);
  }

  snapshot(): Snapshot {
    const stepIndex = this.stepAt(this.tick);
    const step = this.score.playOrder[stepIndex];
    const onset = step ? this.score.onsets[step.onsetIndex] : undefined;
    return {
      state: this.state,
      kind: this.kind,
      playedTick: this.tick,
      stepIndex,
      onsetIndex: step?.onsetIndex ?? 0,
      measureIndex: onset?.measureIndex ?? 0,
    };
  }

  start(): void {
    if (this.state !== 'idle' && this.state !== 'ended') return;
    this.tick = this.startTick;
    this.states.fill('pending');
    this.resolved.fill(0);
    this.pending = [];
    this.closed = 0;
    // Ticket 07 sends the play through `counting-in` here when `settings.countInBars` is set.
    this.state = 'running';
  }

  /** Practice only: the clock freezes and the cursor drops back to the bar it stands in. */
  pause(): void {
    if (this.state !== 'running') return;
    this.tick = this.barStartOf(this.tick);
    this.state = 'paused';
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.state = 'running';
  }

  /** Back to Idle at the start point, whatever the play was doing. */
  abort(): void {
    this.state = 'idle';
    this.tick = this.startTick;
  }

  restart(): void {
    this.abort();
  }

  /**
   * Moves the clock by wall time. `wallMs` is the frame's own clock, on the same timeline as a
   * strike's timestamp (`performance.timeOrigin + performance.now()`); without it the engine keeps
   * its own, which is what the tests count in.
   */
  advance(ms: number, wallMs?: number): void {
    this.wall = wallMs ?? this.wall + ms;
    if (this.state !== 'running') return;
    const end = this.endTick;
    let left = ms;
    for (let guard = 0; left > 1e-9 && guard < 10_000; guard++) {
      const rate = this.ticksPerMs(this.tick);
      const limit = Math.min(this.nextBoundary(this.tick), end);
      const want = this.tick + left * rate;
      if (want < limit) {
        this.tick = want;
        this.closeWindows();
        return;
      }
      left -= (limit - this.tick) / rate;
      this.tick = limit;
      this.closeWindows();
      if (this.tick >= end) {
        // A practice ends back where it started; a performance stays for its summary card.
        if (this.kind === 'practice') this.abort();
        else this.state = 'ended';
        return;
      }
    }
  }

  /**
   * Where the played keys reach the engine. A note-on is matched against the expected notes of the
   * active hand nearest in time inside the matching window; a note-off only releases the key.
   * Ticket 08 clears Wait mode stops from here.
   */
  strike(event: StrikeEvent): void {
    if (!event.on) {
      this.held.delete(event.midi);
      return;
    }
    // Outside a running play a key lights the keyboard and reaches no note.
    if (this.state !== 'running') {
      this.held.set(event.midi, -1);
      return;
    }
    const at = this.tickAt(event.time);
    const window = this.msToTicks(this.settings.matchingWindowMs, at);
    const hit = this.nearest(event.midi, at, window, true);
    if (hit >= 0) {
      this.states[hit] = 'hit';
      this.resolved[hit] = event.time;
      this.held.set(event.midi, hit);
      this.pending.push({ verdict: 'hit', midi: event.midi, noteIndex: hit, time: event.time });
      return;
    }
    const absorbed = this.nearest(event.midi, at, window, false) >= 0;
    this.held.set(event.midi, -1);
    this.pending.push({
      verdict: absorbed ? 'absorbed' : 'extra',
      midi: event.midi,
      noteIndex: -1,
      time: event.time,
    });
  }

  /** The played tick a strike landed on, read back from the wall clock of the last frame. */
  private tickAt(wallMs: number): number {
    return this.tick - (this.wall - wallMs) * this.ticksPerMs(this.tick);
  }

  /** In Flow mode the player is asked for the strikeable notes of the active hand, graces aside. */
  private isExpected(note: PlayNote): boolean {
    const { hands } = this.settings;
    return !note.grace && (hands === 'both' || hands === note.hand);
  }

  /**
   * The note nearest in time to a strike inside the window: an unmatched expected one when
   * `expected` is set, an inactive-hand or grace note otherwise, which absorbs the strike.
   */
  private nearest(midi: number, at: number, window: number, expected: boolean): number {
    let best = -1;
    let bestDistance = Infinity;
    for (let i = this.firstNoteFrom(at - window); i < this.notes.length; i++) {
      const note = this.notes[i]!;
      if (note.tick > at + window) break;
      if (note.midi !== midi || this.isExpected(note) !== expected) continue;
      if (expected && this.states[i] !== 'pending') continue;
      const distance = Math.abs(note.tick - at);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  }

  /** An expected note the clock has left behind unmatched is a miss, once. */
  private closeWindows(): void {
    const window = this.msToTicks(this.settings.matchingWindowMs, this.tick);
    while (this.closed < this.notes.length) {
      const note = this.notes[this.closed]!;
      if (note.tick + window >= this.tick) break;
      const index = this.closed++;
      if (this.states[index] !== 'pending' || !this.isExpected(note)) continue;
      this.states[index] = 'miss';
      this.resolved[index] = this.wall;
      this.pending.push({ verdict: 'miss', midi: note.midi, noteIndex: index, time: this.wall });
    }
  }

  /** The first note at or after a played tick. `notes` is in played order. */
  private firstNoteFrom(tick: number): number {
    let lo = 0;
    let hi = this.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.notes[mid]!.tick < tick) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Sheet tick of the played tick: the same bar played twice reads the same written moment. */
  private sheetTickOf(playedTick: number): number {
    const step = this.score.playOrder[this.stepAt(playedTick)];
    if (!step) return playedTick;
    return (this.score.onsets[step.onsetIndex]?.tick ?? 0) + (playedTick - step.tick);
  }

  private ticksPerMs(playedTick: number): number {
    const { tempoMode, tempoValue } = this.settings;
    const written = writtenBpm(this.score, this.sheetTickOf(playedTick));
    const bpm = tempoMode === 'bpm' ? tempoValue : (written * tempoValue) / 100;
    return (bpm * TICKS_PER_QUARTER) / 60_000;
  }

  private msToTicks(ms: number, playedTick: number): number {
    return ms * this.ticksPerMs(playedTick);
  }

  /**
   * The next played tick where the clock's speed may change: the start of the next step, or the
   * tempo mark that falls inside the step the clock is in.
   */
  private nextBoundary(playedTick: number): number {
    const index = this.stepAt(playedTick);
    const step = this.score.playOrder[index];
    if (!step) return Infinity;
    const nextStep = this.score.playOrder[index + 1]?.tick ?? Infinity;
    const sheetTick = this.sheetTickOf(playedTick);
    let next = Infinity;
    for (const entry of this.score.tempoMap) {
      if (entry.tick > sheetTick) {
        next = step.tick + (entry.tick - (this.score.onsets[step.onsetIndex]?.tick ?? 0));
        break;
      }
    }
    return Math.min(nextStep, next);
  }

  /** Played tick of the bar line that opens the bar the played tick stands in. */
  private barStartOf(playedTick: number): number {
    const step = this.score.playOrder[this.stepAt(playedTick)];
    if (!step) return playedTick;
    const onset = this.score.onsets[step.onsetIndex];
    const measure = onset ? this.score.measures[onset.measureIndex] : undefined;
    if (!onset || !measure) return playedTick;
    return step.tick - (onset.tick - measure.startTick);
  }

  /** The last step at or before a played tick. `playOrder` ticks never go back. */
  private stepAt(playedTick: number): number {
    const order = this.score.playOrder;
    let lo = 0;
    let hi = order.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (order[mid]!.tick <= playedTick) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

/** Shared empty result of `events()`, so a quiet frame allocates nothing. */
const EMPTY_EVENTS: PlayEvent[] = [];

/**
 * Every note of the piece in played order. A repeated bar appears once per pass; a tie
 * continuation appears not at all, because the note that starts the tie carries the whole chain.
 */
function playNotesOf(score: Score): PlayNote[] {
  const notes: PlayNote[] = [];
  for (const step of score.playOrder) {
    for (const note of score.onsets[step.onsetIndex]?.notes ?? []) {
      if (!note.strikeable) continue;
      notes.push({
        midi: note.midi,
        tick: step.tick,
        durationTicks: note.durationTicks,
        hand: note.hand,
        grace: note.grace,
        measureIndex: note.measureIndex,
        note,
      });
    }
  }
  return notes;
}

export function create(score: Score, settings: PlaySettings): Engine {
  return new Engine(score, settings);
}

/** End of the last written duration over the whole play order, both hands. */
function lastSoundingTickOf(score: Score): number {
  let last = 0;
  for (const step of score.playOrder) {
    for (const note of score.onsets[step.onsetIndex]?.notes ?? []) {
      last = Math.max(last, step.tick + note.durationTicks);
    }
  }
  return last;
}
