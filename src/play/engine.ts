// The play engine: the clock of one play and where it stands in the Score. Pure TypeScript, no
// DOM, no React, no timer of its own. The screen owns the frame loop and feeds it wall time.

import type { PlaySettings } from '@/play/settings';
import { TICKS_PER_QUARTER, bpmAt, type Score } from '@/score/types';

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
  kind: PlayKind = 'practice';

  private state: PlayState = 'idle';
  private tick = 0;
  /** Played tick the play parks at when Idle, and returns to on restart. */
  private startTick = 0;
  private readonly lastSoundingTick: number;

  constructor(score: Score, settings: PlaySettings) {
    this.score = score;
    this.settings = settings;
    this.lastSoundingTick = lastSoundingTickOf(score);
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

  /** Moves the clock by wall time. Nothing happens unless the play is running. */
  advance(ms: number): void {
    if (this.state !== 'running') return;
    const end = this.endTick;
    let left = ms;
    for (let guard = 0; left > 1e-9 && guard < 10_000; guard++) {
      const rate = this.ticksPerMs(this.tick);
      const limit = Math.min(this.nextBoundary(this.tick), end);
      const want = this.tick + left * rate;
      if (want < limit) {
        this.tick = want;
        return;
      }
      left -= (limit - this.tick) / rate;
      this.tick = limit;
      if (this.tick >= end) {
        // A practice ends back where it started; a performance stays for its summary card.
        if (this.kind === 'practice') this.abort();
        else this.state = 'ended';
        return;
      }
    }
  }

  /** Where the played keys reach the engine. Ticket 06 matches them, 08 clears Wait mode stops. */
  strike(_event: StrikeEvent): void {}

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
