// The play engine: the clock of one play and where it stands in the Score. Pure TypeScript, no
// DOM, no React, no timer of its own. The screen owns the frame loop and feeds it wall time.

import { playGrade, type NoteStrike, type PlayGrade } from '@/play/grade';
import type { HandsSetting, PlaySettings, TempoMode } from '@/play/settings';
import { WaitState } from '@/play/wait';
import {
  TICKS_PER_QUARTER,
  bpmAt,
  type Hand,
  type Measure,
  type Note,
  type Score,
} from '@/score/types';

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

/** What one finished practice leaves for the library: its start in Unix time and its motion. */
export interface PracticeRecord {
  startedAt: number;
  /** Time the clock actually moved, count-in and pauses left out. */
  seconds: number;
}

/** What one finished performance leaves for the library: its time, its settings and its numbers. */
export interface PerformanceRecord {
  startedAt: number;
  /** Time the clock moved, count-in left out. */
  seconds: number;
  tempoMode: TempoMode;
  tempoValue: number;
  hands: HandsSetting;
  /** Null when the run asked nothing of the player, so there was nothing to grade. */
  grade: PlayGrade | null;
}

/** What a matched note gathers while the play runs, before Grade reads it. */
interface Struck {
  timingMs: number;
  velocity: number;
  onMs: number;
  /** Wall-clock milliseconds the key came up, null while it is still down. */
  offMs: number | null;
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
  /** Wait mode: the clock stands still at `stepIndex` until the player satisfies its Onset. */
  stopped: boolean;
}

/** What `held` says a strike matched: nothing, so it blocks, or a note that took it in silence. */
const BLOCKING = -1;
const ABSORBED = -2;

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
  /** Played ticks of the beats being counted in, before the tick the count-in leads to. */
  countInBeats: number[] = [];
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
  /** Keys down now: pitch to the note its strike matched, or `BLOCKING` / `ABSORBED`. */
  private readonly held = new Map<number, number>();
  private pending: PlayEvent[] = [];
  /** First note whose matching window is still open; everything before it is settled. */
  private closed = 0;
  private readonly wait = new WaitState();
  /** Wait mode: the play order step the cursor waits at, or null while it glides. */
  private stopStep: number | null = null;

  /** Every beat of the play in played ticks, the grid the metronome clicks on. */
  private readonly beatGrid: number[];
  /** First beat of the grid the clock has not passed yet. */
  private beatNext = 0;
  /** Clicks owed to the screen, taken by `beats()`. */
  private clicks = 0;
  /** First count-in beat the clock has not passed yet. */
  private countInNext = 0;
  /** Played tick the count-in leads to, which is where motion starts. */
  private countInTo = 0;

  /** Milliseconds the clock has moved since the play started: what a practice row stores. */
  private motionMs = 0;
  /** Unix milliseconds of the first motion of this play. */
  private startedAt = 0;
  /** Step the play started at, against which "the cursor passed an Onset" is read. */
  private startStep = 0;
  private passedOnset = false;
  private record: PracticeRecord | null = null;
  /** The settings a performance started at; a live write to `settings` does not reach the run. */
  private frozen: Pick<PlaySettings, 'tempoMode' | 'tempoValue' | 'hands' | 'mode'> | null = null;
  /** What each matched note gathered, by index into `notes`. */
  private struck: (Struck | undefined)[] = [];
  /** Strikes that matched nothing, which enlarge the denominator of the grade. */
  private extras = 0;
  private performance: PerformanceRecord | null = null;

  constructor(score: Score, settings: PlaySettings) {
    this.score = score;
    this.settings = settings;
    this.lastSoundingTick = lastSoundingTickOf(score);
    this.notes = playNotesOf(score);
    this.states = this.notes.map(() => 'pending');
    this.resolved = this.notes.map(() => 0);
    this.beatGrid = beatGridOf(score);
  }

  /** What the clock and the matching run on: a performance keeps the settings it started at. */
  private get live(): Pick<PlaySettings, 'tempoMode' | 'tempoValue' | 'hands' | 'mode'> {
    return this.frozen ?? this.settings;
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

  /**
   * Takes the clicks the metronome owes since the last call: a beat of the grid the clock crossed
   * while the metronome is on, and every count-in beat whether it is on or not.
   */
  beats(): number {
    const clicks = this.clicks;
    this.clicks = 0;
    return clicks;
  }

  /** Seconds the clock has moved in this play, count-in and pauses left out. */
  get motionSeconds(): number {
    return this.motionMs / 1000;
  }

  /**
   * Takes the practice a stop left to be stored, if any. A play that never passed an Onset leaves
   * nothing, and nothing is left twice.
   */
  takePractice(): PracticeRecord | null {
    const record = this.record;
    this.record = null;
    return record;
  }

  /**
   * Takes the performance the end left to be stored, if any. An aborted performance leaves nothing,
   * and nothing is left twice.
   */
  takePerformance(): PerformanceRecord | null {
    const record = this.performance;
    this.performance = null;
    return record;
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
      stopped: this.stopStep !== null,
    };
  }

  start(): void {
    if (this.state !== 'idle' && this.state !== 'ended') return;
    this.tick = this.startTick;
    this.states.fill('pending');
    this.resolved.fill(0);
    this.pending = [];
    this.closed = 0;
    this.wait.reset();
    this.stopStep = null;
    this.motionMs = 0;
    this.startedAt = 0;
    this.startStep = this.stepAt(this.startTick);
    this.passedOnset = false;
    this.struck = [];
    this.extras = 0;
    this.performance = null;
    // A performance runs the whole piece in Flow at the tempo and hands it was started with.
    const { tempoMode, tempoValue, hands } = this.settings;
    this.frozen =
      this.kind === 'performance' ? { tempoMode, tempoValue, hands, mode: 'flow' } : null;
    this.beginMotion(this.startTick);
  }

  /**
   * Arms a performance, Idle at bar one. The practice it interrupts stops here, so its time is
   * stored on the way in.
   */
  arm(): void {
    this.abort();
    this.kind = 'performance';
    this.startTick = 0;
    this.tick = 0;
    this.syncBeats();
  }

  /** Practice only: the clock freezes and the cursor drops back to the bar it stands in. */
  pause(): void {
    // A performance has no pause: the disc, Stop and Escape all end it, and it leaves no row.
    if (this.kind === 'performance') {
      this.abort();
      return;
    }
    // A count-in is not motion to pause: the play drops back to Idle where the count-in led, which
    // is a stop, so what it had already played is stored.
    if (this.state === 'counting-in') {
      this.stopRecord();
      this.tick = this.countInTo;
      this.countInBeats = [];
      this.state = 'idle';
      this.syncBeats();
      return;
    }
    if (this.state !== 'running') return;
    this.tick = this.barStartOf(this.tick);
    this.state = 'paused';
    this.forgetSatisfied(this.stepAt(this.tick));
    this.syncBeats();
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.beginMotion(this.tick);
  }

  /** Back to Idle at the start point, whatever the play was doing. */
  abort(): void {
    this.stopRecord();
    // Whatever a performance had reached dies with it; only a complete run leaves a row.
    this.kind = 'practice';
    this.frozen = null;
    this.performance = null;
    this.state = 'idle';
    this.tick = this.startTick;
    this.stopStep = null;
    this.countInBeats = [];
    this.syncBeats();
  }

  /** Wait mode asks for every Onset from a play order step again, and waits at it if it must. */
  forgetSatisfied(fromStep = 0): void {
    this.wait.forgetFrom(fromStep);
    this.stopStep = null;
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
    if (this.state === 'counting-in') ms = this.advanceCountIn(ms);
    if (this.state !== 'running' || ms <= 0) return;
    // A Wait mode stop is time at the piano, so it counts as practice; a count-in and a pause do not.
    if (this.startedAt === 0) this.startedAt = this.wall;
    this.motionMs += ms;
    // A play switched to Flow glides on from wherever Wait mode was holding it.
    if (this.live.mode !== 'wait') this.stopStep = null;
    if (this.stopStep !== null) {
      // A live hands change can leave the Onset the cursor waits at asking for less, or nothing.
      if (this.requiredOf(this.stopStep).length === 0) this.stopStep = null;
      else this.settleWait();
      if (this.stopStep !== null) return;
    }
    const end = this.endTick;
    let left = ms;
    for (let guard = 0; left > 1e-9 && guard < 10_000; guard++) {
      const rate = this.ticksPerMs(this.tick);
      const stop = this.nextStop();
      const stopTick = stop < 0 ? Infinity : this.score.playOrder[stop]!.tick;
      const limit = Math.min(this.nextBoundary(this.tick), end, stopTick);
      const want = this.tick + left * rate;
      if (want < limit) {
        this.tick = want;
        this.crossGrid();
        this.closeWindows();
        return;
      }
      left -= (limit - this.tick) / rate;
      this.tick = limit;
      this.crossGrid();
      this.closeWindows();
      if (this.tick >= end) {
        // A practice ends back where it started; a performance stays for its summary card.
        if (this.kind === 'practice') this.abort();
        else {
          this.state = 'ended';
          this.endRecord();
        }
        return;
      }
      if (this.tick === stopTick) {
        this.stopStep = stop;
        return;
      }
    }
  }

  /**
   * Starts motion at a played tick, through the count-in when it is on. Everything that starts the
   * clock goes through here, so the count-in runs before each of them.
   */
  private beginMotion(to: number): void {
    const bars = Math.floor(this.settings.countInBars);
    const measure = this.measureAt(to);
    this.countInTo = to;
    if (bars >= 1 && measure) {
      const beat = beatOf(measure);
      this.countInBeats = [];
      for (let left = bars * beat.perBar; left > 0; left--) {
        this.countInBeats.push(to - left * beat.ticks);
      }
      this.countInNext = 0;
      this.tick = this.countInBeats[0]!;
      this.state = 'counting-in';
    } else {
      this.state = 'running';
    }
    this.syncBeats();
  }

  /**
   * The count-in phase of the clock, at the tempo of the tick it leads to. Returns the milliseconds
   * left over once it is done, which are the play's first motion.
   */
  private advanceCountIn(ms: number): number {
    const rate = this.ticksPerMs(this.countInTo);
    const want = this.tick + ms * rate;
    this.tick = Math.min(want, this.countInTo);
    while (
      this.countInNext < this.countInBeats.length &&
      this.countInBeats[this.countInNext]! <= this.tick
    ) {
      this.countInNext++;
      this.clicks++;
    }
    if (want < this.countInTo) return 0;
    this.countInBeats = [];
    this.syncBeats();
    this.state = 'running';
    return (want - this.countInTo) / rate;
  }

  /** What the clock sets off by moving: the metronome's beats and the first Onset it passes. */
  private crossGrid(): void {
    while (this.beatNext < this.beatGrid.length && this.beatGrid[this.beatNext]! <= this.tick) {
      this.beatNext++;
      if (this.settings.metronome) this.clicks++;
    }
    if (!this.passedOnset && this.stepAt(this.tick) > this.startStep) this.passedOnset = true;
  }

  /**
   * Puts the metronome back on the grid after the tick moved by itself, without a click. A beat the
   * clock stands exactly on is still owed, so a play starting on a bar line clicks its downbeat.
   */
  private syncBeats(): void {
    let lo = 0;
    let hi = this.beatGrid.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.beatGrid[mid]! < this.tick) lo = mid + 1;
      else hi = mid;
    }
    this.beatNext = lo;
  }

  /** A stop keeps the practice's motion for the library; a play that passed no Onset keeps none. */
  private stopRecord(): void {
    if (this.kind !== 'practice' || !this.passedOnset || this.motionMs <= 0) return;
    this.record = { startedAt: this.startedAt, seconds: this.motionMs / 1000 };
    this.motionMs = 0;
    this.passedOnset = false;
  }

  /**
   * The numbers a complete performance leaves. Only expected notes whose matching window closed
   * before the end count; a key still down has no release ratio.
   */
  private endRecord(): void {
    const notes: (NoteStrike | null)[] = [];
    for (let i = 0; i < this.closed; i++) {
      const note = this.notes[i]!;
      if (!this.isExpected(note)) continue;
      const struck = this.struck[i];
      if (!struck) {
        notes.push(null);
        continue;
      }
      const held = struck.offMs === null ? null : struck.offMs - struck.onMs;
      const written = note.durationTicks / this.ticksPerMs(note.tick);
      notes.push({
        timingMs: struck.timingMs,
        velocity: struck.velocity,
        ideal: note.note.velocity,
        release: held === null || written <= 0 ? null : held / written,
      });
    }
    this.performance = {
      startedAt: this.startedAt,
      seconds: this.motionMs / 1000,
      tempoMode: this.live.tempoMode,
      tempoValue: this.live.tempoValue,
      hands: this.live.hands,
      grade: playGrade(notes, this.extras, this.settings, this.score.hasDynamics),
    };
  }

  private measureAt(playedTick: number): Measure | undefined {
    const step = this.score.playOrder[this.stepAt(playedTick)];
    const onset = step ? this.score.onsets[step.onsetIndex] : undefined;
    return onset ? this.score.measures[onset.measureIndex] : undefined;
  }

  /**
   * Where the played keys reach the engine. A note-on is matched against the expected notes of the
   * active hand nearest in time inside the matching window; a note-off only releases the key.
   * Ticket 08 clears Wait mode stops from here.
   */
  strike(event: StrikeEvent): void {
    if (!event.on) {
      const matched = this.held.get(event.midi) ?? BLOCKING;
      const struck = matched < 0 ? undefined : this.struck[matched];
      if (struck && struck.offMs === null) struck.offMs = event.time;
      this.held.delete(event.midi);
      this.wait.release(event.midi);
      // A blocking or a required key coming up may be the last thing a stop was waiting for.
      if (this.waiting) this.settleWait();
      return;
    }
    // Outside a running play a key lights the keyboard and reaches no note.
    if (this.state !== 'running') {
      this.held.set(event.midi, BLOCKING);
      return;
    }
    if (this.waiting) {
      this.strikeWaiting(event);
      return;
    }
    const at = this.tickAt(event.time);
    const window = this.msToTicks(this.settings.matchingWindowMs, at);
    const hit = this.nearest(event.midi, at, window, true);
    if (hit >= 0) {
      const note = this.notes[hit]!;
      this.struck[hit] = {
        timingMs: (at - note.tick) / this.ticksPerMs(note.tick),
        velocity: event.velocity,
        onMs: event.time,
        offMs: null,
      };
      this.states[hit] = 'hit';
      this.resolved[hit] = event.time;
      this.held.set(event.midi, hit);
      this.pending.push({ verdict: 'hit', midi: event.midi, noteIndex: hit, time: event.time });
      return;
    }
    const absorbed = this.nearest(event.midi, at, window, false) >= 0;
    if (!absorbed) this.extras++;
    this.held.set(event.midi, absorbed ? ABSORBED : BLOCKING);
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
    const { hands } = this.live;
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
    const { tempoMode, tempoValue } = this.live;
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

  // Wait mode. The cursor glides at tempo and stands at every Onset the player has not satisfied.

  /** Wait mode only bites while the play is moving through the Score. */
  private get waiting(): boolean {
    return this.live.mode === 'wait' && this.state === 'running';
  }

  /** A held key whose strike matched nothing blocks every Onset until it comes up. */
  private get blocked(): boolean {
    for (const matched of this.held.values()) if (matched === BLOCKING) return true;
    return false;
  }

  /**
   * A strike goes to the earliest unsatisfied Onset whose window has opened and which asks for that
   * pitch. A grace or inactive-hand note of the current or next Onset absorbs it instead; anything
   * else is an extra, which costs nothing but blocks while the key is held.
   */
  private strikeWaiting(event: StrikeEvent): void {
    // While the cursor stands still a strike lands where the cursor is, however late it comes.
    const at = this.stopStep === null ? this.tickAt(event.time) : this.tick;
    const step = this.openStepFor(event.midi, at);
    if (step >= 0) {
      const index = this.noteAt(step, event.midi);
      this.wait.count(step, event.midi, event.time);
      this.states[index] = 'hit';
      this.resolved[index] = event.time;
      this.held.set(event.midi, index);
      this.pending.push({ verdict: 'hit', midi: event.midi, noteIndex: index, time: event.time });
    } else {
      const absorbed = this.absorbs(event.midi);
      this.held.set(event.midi, absorbed ? ABSORBED : BLOCKING);
      this.pending.push({
        verdict: absorbed ? 'absorbed' : 'extra',
        midi: event.midi,
        noteIndex: -1,
        time: event.time,
      });
    }
    this.settleWait();
  }

  /** Adds up every Onset holding strikes; satisfying the one the cursor stands at ends the stop. */
  private settleWait(): void {
    const { blocked } = this;
    for (const step of this.wait.open()) {
      if (!this.wait.settle(step, this.requiredOf(step), this.settings.togethernessMs, blocked)) {
        continue;
      }
      if (this.stopStep === step) this.stopStep = null;
    }
  }

  /** The earliest step open at a played tick that requires the pitch, -1 when no step does. */
  private openStepFor(midi: number, at: number): number {
    const order = this.score.playOrder;
    const window = this.msToTicks(this.settings.matchingWindowMs, at);
    for (let i = this.stopStep ?? this.stepAt(Math.min(at, this.tick)); i < order.length; i++) {
      if (order[i]!.tick - window > at) break;
      if (this.wait.satisfied(i)) continue;
      if (this.requiredOf(i).includes(midi)) return i;
    }
    return -1;
  }

  /** Whether a note the play never asks for, at the current or the next Onset, takes the strike. */
  private absorbs(midi: number): boolean {
    const current = this.stopStep ?? this.stepAt(this.tick);
    for (const step of [current, current + 1]) {
      const [from, to] = this.noteRange(step);
      for (let i = from; i < to; i++) {
        const note = this.notes[i]!;
        if (note.midi === midi && !this.isExpected(note)) return true;
      }
    }
    return false;
  }

  /** The next step the cursor must wait at, at or after the tick; -1 when nothing stops it. */
  private nextStop(): number {
    if (!this.waiting) return -1;
    const order = this.score.playOrder;
    for (let i = this.stepAt(this.tick); i < order.length; i++) {
      if (order[i]!.tick < this.tick) continue;
      if (this.wait.satisfied(i) || this.requiredOf(i).length === 0) continue;
      return i;
    }
    return -1;
  }

  /** What an Onset asks for: the pitches of its strikeable notes of the active hand, graces aside. */
  private requiredOf(step: number): number[] {
    const [from, to] = this.noteRange(step);
    const pitches: number[] = [];
    for (let i = from; i < to; i++) {
      const note = this.notes[i]!;
      if (this.isExpected(note)) pitches.push(note.midi);
    }
    return pitches;
  }

  /** The note of that pitch the strike marks: the first one of the Onset still pending. */
  private noteAt(step: number, midi: number): number {
    const [from, to] = this.noteRange(step);
    let fallback = -1;
    for (let i = from; i < to; i++) {
      if (this.notes[i]!.midi !== midi || !this.isExpected(this.notes[i]!)) continue;
      if (this.states[i] === 'pending') return i;
      if (fallback < 0) fallback = i;
    }
    return fallback;
  }

  /** The stretch of `notes` one Onset of the play order covers, as `[from, to)`. */
  private noteRange(step: number): [number, number] {
    const tick = this.score.playOrder[step]?.tick;
    if (tick === undefined) return [0, 0];
    const from = this.firstNoteFrom(tick);
    let to = from;
    while (to < this.notes.length && this.notes[to]!.tick === tick) to++;
    return [from, to];
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

/**
 * The beat the metronome clicks and how many of them a full bar holds: the time signature's unit,
 * a dotted quarter in the compound meters 6/8, 9/8 and 12/8.
 */
export function beatOf(measure: Measure): { ticks: number; perBar: number } {
  const unit = (TICKS_PER_QUARTER * 4) / measure.beatUnit;
  const compound =
    measure.beatUnit === 8 && measure.beatsPerBar > 3 && measure.beatsPerBar % 3 === 0;
  return compound
    ? { ticks: unit * 3, perBar: measure.beatsPerBar / 3 }
    : { ticks: unit, perBar: measure.beatsPerBar };
}

/**
 * Every beat of the play in played ticks, one pass per repeat. A pickup bar's beats are laid from
 * its bar line backwards, so its last beat lands on the next bar line.
 */
function beatGridOf(score: Score): number[] {
  const ticks: number[] = [];
  for (const step of score.playOrder) {
    const onset = score.onsets[step.onsetIndex];
    const measure = onset ? score.measures[onset.measureIndex] : undefined;
    if (!onset || !measure) continue;
    const barTick = step.tick - (onset.tick - measure.startTick);
    if (ticks.length > 0 && ticks[ticks.length - 1]! >= barTick) continue;
    const { ticks: beat } = beatOf(measure);
    const end = barTick + measure.durationTicks;
    for (let tick = barTick + (measure.durationTicks % beat); tick < end - 1e-9; tick += beat) {
      ticks.push(tick);
    }
  }
  return ticks;
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
