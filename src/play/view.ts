// What a view of a play sees of it, and what the Play asks of a view. The sheet and the lane draw
// the same play from the same reads: neither holds state of the clock, and the only two things
// either asks of the play are a seek and a Section.

import type {
  KeyState,
  LoopSpan,
  NoteState,
  PlayEvent,
  PlayNote,
  SeekTarget,
  Snapshot,
} from '@/play/engine';
import type { Section } from '@/play/section';
import type { PlaySettings } from '@/play/settings';
import type { PlayStep, Score } from '@/score/types';
import type { LaneLook } from '@/lane/look';
import type { SheetLook } from '@/sheet/sheet';
import type { Pinch } from '@/sheet/pinch';

/**
 * The play as a view reads it: the engine narrowed to what a frame draws, plus the two moves a
 * pointer on either view makes. The Engine itself satisfies it, which is what a view test runs on.
 */
export interface PlayView {
  readonly score: Score;
  /** The played timeline the clock runs along, which Loop over a Section swaps. */
  readonly walk: PlayStep[];
  readonly notes: PlayNote[];
  noteState(index: number): NoteState;
  /** Wall-clock time the note was settled at; 0 while it is pending. */
  resolvedAt(index: number): number;
  keyState(midi: number): KeyState;
  heldNote(midi: number): number;
  readonly section: Section | null;
  loopSpan(): LoopSpan | null;
  readonly settings: Readonly<PlaySettings>;
  /** Played ticks of the beats being counted in. */
  readonly countInBeats: number[];
  /** The matching window in played ticks, which the cursor band takes its width from. */
  readonly windowTicks: number;
  /** Counters a view watches: the notes opened again, a state write, a loop wrap, an ending. */
  readonly resets: number;
  readonly version: number;
  readonly wraps: number;
  readonly finishes: number;
  seek(target: SeekTarget): void;
  setSection(section: Section | null): void;
}

/** One view of a play: the Play opens it, feeds it every frame and disposes it on the way out. */
interface View {
  open(play: PlayView, host: HTMLElement): void;
  /** One frame. `now` is the animation clock; `wall` is the clock a strike is stamped on. */
  frame(snap: Snapshot, now: number, wall: number): void;
  setDark(dark: boolean): void;
  dispose(): void;
}

/** The sheet, as the Play holds it: every view's own, and the paper's own looks. */
export interface SheetView extends View {
  /** What a pinch is choosing while it lasts, which the panel over the paper shows. */
  readonly pinching: Pinch | null;
  /** The end of a practice, which is the one ending the paper animates. */
  finish(): void;
  setLook(look: Partial<SheetLook>): void;
  setProportional(on: boolean): void;
  setSpacing(percent: number): void;
}

/** The falling notes, as the Play holds them: every view's own, and the keyboard they lay out. */
export interface LaneView extends View {
  /** Live look knobs: the Play writes into this object and the next frame reads it. */
  readonly look: LaneLook;
  /** One strike or one closing note, which the lane answers with a mark that plays out. */
  effect(event: PlayEvent, wall: number): void;
  /** Shown over the keys while the app has no MIDI input. */
  notice: string | null;
  /** Lays the keyboard out again, which a change of the keyboard size asks for. */
  setRange(): void;
}
