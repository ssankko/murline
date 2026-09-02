// One Preview of one piece: the note list the sound engine schedules, the clock it reports back,
// the tempo the piece keeps and the band the sheet walks. The screen hands it a frame and the keys,
// reads one snapshot out of it and draws; nothing of the transport lives in React.

import { openPiece } from '@/library/open-piece';
import { clamp } from '@/lib/utils';
import type { SeekTarget } from '@/play/engine';
import { convertTempo, TEMPO_RANGE, type TempoMode } from '@/play/settings';
import { nearestTick, playedTicksOf, stepTarget } from '@/play/step';
import { previewNotes, secondsOf, tickAt, type PreviewNote } from '@/preview/notes';
import { bpmAt, stepSeconds, type Score } from '@/score/types';
import { set, setting, subscribe } from '@/settings/settings';
import type { Pinch } from '@/sheet/pinch';
import { PreviewSheet, windowTicksOf } from '@/sheet/preview-sheet';
import type { SheetLook } from '@/sheet/sheet';
import { commands } from '@/bindings';
import { on } from '@/rust';

/** The sheet as the Preview drives it: the Score behind it, the band, the Look and the callbacks. */
export interface PreviewSheetView {
  readonly score: Score;
  /** The matching window in played ticks, which the band takes its width from. */
  windowTicks: number;
  seekTo: ((target: SeekTarget) => void) | null;
  spacedTo: ((spacing: number) => void) | null;
  pinching: ((pinch: Pinch | null) => void) | null;
  frame(playedTick: number, playing: boolean, now: number): void;
  finish(): void;
  fit(): void;
  setDark(dark: boolean): void;
  setLook(look: Partial<SheetLook>): void;
  setProportional(on: boolean): void;
  setSpacing(percent: number): void;
  dispose(): void;
}

/** Everything the screen draws of a Preview. One object, replaced whenever any of it changes. */
export interface PreviewShown {
  /** The score's title, empty until a piece is open. */
  title: string;
  playing: boolean;
  /** The tempo is the piece's own: a percent of the written marks or a flat quarter BPM. */
  tempoMode: TempoMode;
  tempo: number;
  /** The score's own tempo, and whether it has only one, which is what BPM mode needs. */
  written: { bpm: number; constant: boolean };
  /** What a pinch on the page is choosing while it lasts. */
  pinch: Pinch | null;
  /** Why there is no sound, empty when there is. */
  reason: string;
}

/** What a Preview stands on before one is open, which is what the screen draws while it opens. */
export const NO_PREVIEW: PreviewShown = {
  title: '',
  playing: false,
  tempoMode: 'percent',
  tempo: 100,
  written: { bpm: 120, constant: false },
  pinch: null,
  reason: '',
};

/** What one Preview is built from: the piece's path and tempo, the sheet, and why it may be silent. */
export interface PreviewOptions {
  path: string;
  sheet: PreviewSheetView;
  tempoMode: TempoMode;
  tempoValue: number;
  reason: string;
}

export class Preview {
  private readonly path: string;
  private readonly sheet: PreviewSheetView;
  /** The note list as the engine takes it, built once from the Score. */
  private readonly notes: PreviewNote[];
  /** The second each step of the play order opens at, which the engine's seconds are read against. */
  private readonly starts: number[];
  /** Takes this Preview off every global setting and every event it answers to. */
  private readonly stops: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private shown: PreviewShown;
  /** Whether Rust holds this piece's note list, which is what makes resume a resume. */
  private loaded = false;
  /** The engine's last report, when it landed and the rate it was running at. */
  private clock = { seconds: 0, at: performance.now(), playing: false, rate: 1 };

  /**
   * Opens the piece, renders its sheet, asks the sound engine whether it can play, and builds the
   * Preview over them. Every failure of the open throws, and the screen says what went wrong.
   */
  static async open(o: {
    folder: string;
    path: string;
    dark: boolean;
    host: HTMLElement;
  }): Promise<Preview> {
    const { bytes, fileName, resolved } = await openPiece(o.folder, o.path);
    const sheet = await PreviewSheet.open(
      o.host,
      bytes,
      fileName,
      o.dark,
      setting('sheet_proportional'),
      setting('sheet_spacing'),
    );
    const reason = await commands.audioStatus().then(
      (status) => (status.available ? '' : status.reason),
      (error: unknown) => String(error),
    );
    return new Preview({
      path: o.path,
      sheet,
      tempoMode: resolved.tempoMode,
      tempoValue: resolved.tempoValue,
      reason,
    });
  }

  constructor(o: PreviewOptions) {
    this.path = o.path;
    this.sheet = o.sheet;
    const score = o.sheet.score;
    this.notes = previewNotes(score);
    this.starts = stepSeconds(score);
    this.shown = {
      title: score.title,
      playing: false,
      tempoMode: o.tempoMode,
      tempo: o.tempoValue,
      written: {
        bpm: score.hasTempo ? Math.round(bpmAt(score, 0)) : 120,
        constant: score.constantTempo,
      },
      pinch: null,
      reason: o.reason,
    };
    this.clock.rate = this.percent / 100;
    this.sheet.windowTicks = windowTicksOf(score, this.percent);
    this.sheet.seekTo = (target) => void this.seek(target);
    // A pinch has already spaced the page; this only stores what it settled on.
    this.sheet.spacedTo = (spacing) => void set('sheet_spacing', spacing);
    this.sheet.pinching = (pinch) => this.show({ pinch });
    this.sheet.setLook({ harmony: setting('sheet_harmony'), colour: setting('sheet_colour') });
    this.stops.push(
      // The four Look settings the page draws, whether the panel or a pinch writes them.
      subscribe('sheet_proportional', () => this.sheet.setProportional(setting('sheet_proportional'))),
      subscribe('sheet_spacing', () => this.sheet.setSpacing(setting('sheet_spacing'))),
      subscribe('sheet_harmony', () => this.sheet.setLook({ harmony: setting('sheet_harmony') })),
      subscribe('sheet_colour', () => this.sheet.setLook({ colour: setting('sheet_colour') })),
      // Where the playback stands, about thirty times a second. The end of the piece arrives as one
      // more report with the time back at zero and nothing playing.
      on('previewProgress', (at) => {
        this.clock = { ...this.clock, ...at, at: performance.now() };
        if (at.playing) return;
        if (at.seconds === 0) this.sheet.finish();
        this.show({ playing: false });
      }),
    );
  }

  /** What React draws, and the subscription that says it changed. */
  snapshot(): PreviewShown {
    return this.shown;
  }

  subscribe(listen: () => void): () => void {
    this.listeners.add(listen);
    return () => {
      this.listeners.delete(listen);
    };
  }

  /** Where the clock stands now: the last report, carried on at its rate for the time since. */
  seconds(now = performance.now()): number {
    const clock = this.clock;
    return clock.seconds + (clock.playing ? ((now - clock.at) / 1000) * clock.rate : 0);
  }

  /** One frame: the clock read on from the last report, and the band on the tick it names. */
  frame(now: number): void {
    this.sheet.frame(tickAt(this.sheet.score, this.starts, this.seconds(now)), this.clock.playing, now);
  }

  /** Play and pause are the same key and the same disc; the first play hands the engine the piece. */
  async toggle(): Promise<void> {
    if (this.off) return;
    if (this.shown.playing) {
      this.show({ playing: false });
      this.restartClock(this.seconds(), false);
      await commands.previewPause();
      return;
    }
    this.show({ playing: true });
    this.restartClock(this.seconds(), true);
    await this.load();
    await commands.previewPlay();
  }

  /** Back to the start, with the note list gone from Rust: the next play loads it again. */
  rewind(): void {
    this.show({ playing: false });
    this.restartClock(0, false);
    this.loaded = false;
    void commands.previewStop();
  }

  /**
   * Moves the clock to a bar or an Onset. A repeat gives the target one tick per pass, so the pass
   * nearest `near` wins and a target read off the start of the piece lands on the first of them.
   */
  async seek(target: SeekTarget, near = 0): Promise<void> {
    if (this.off) return;
    const score = this.sheet.score;
    const ticks = playedTicksOf(score, score.playOrder, target);
    if (ticks.length === 0) return;
    const tick = nearestTick(ticks, 'tick' in target ? target.tick : near);
    const seconds = secondsOf(score, this.starts, tick);
    // The local clock moves first, so the band stands on the click this frame rather than waiting
    // for the engine to report back.
    this.restartClock(seconds);
    await this.load();
    await commands.previewSeek(seconds);
  }

  /** One arrow key: the Onset or the bar one step away, back or on, in the pass the clock stands in. */
  step(back: boolean, far: boolean): void {
    const score = this.sheet.score;
    // The clock reads back as a fraction of a tick, so a position on an Onset is rounded onto it.
    const at = Math.round(tickAt(score, this.starts, this.seconds()));
    const to = stepTarget(score, score.playOrder, at, back, far);
    if (to) void this.seek(to, at);
  }

  /** Every tempo change goes to the piece row, so the piece reopens at the tempo it was left at. */
  setTempo(value: number): void {
    this.show({ tempo: value });
    this.rate();
    commands.pieceUpdateSettings(this.path, { tempo_value: value }).catch(console.error);
  }

  nudgeTempo(by: number): void {
    this.setTempo(clamp(this.shown.tempo + by, ...TEMPO_RANGE[this.shown.tempoMode]));
  }

  /** The two modes read the same piece at the same speed, so a switch carries the value over. */
  switchMode(next: TempoMode): void {
    const { tempoMode, tempo, written } = this.shown;
    if (next === tempoMode) return;
    const value = convertTempo(tempo, tempoMode, next, written.bpm);
    this.show({ tempoMode: next, tempo: value });
    this.rate();
    commands.pieceUpdateSettings(this.path, { tempo_mode: next, tempo_value: value }).catch(console.error);
  }

  setDark(dark: boolean): void {
    this.sheet.setDark(dark);
  }

  fit(): void {
    this.sheet.fit();
  }

  /** Leaving silences the engine at once, whatever it was doing, and takes the page down with it. */
  dispose(): void {
    void commands.previewStop();
    for (const stop of this.stops) stop();
    this.sheet.dispose();
  }

  private get off(): boolean {
    return this.shown.reason !== '';
  }

  /** Rust runs at a percent, so BPM mode is that BPM against the tempo the piece is written at. */
  private get percent(): number {
    const { tempoMode, tempo, written } = this.shown;
    return tempoMode === 'bpm' ? Math.round((100 * tempo) / written.bpm) : tempo;
  }

  /** Restarts the extrapolation from where the clock stands, at the rate in force now. */
  private restartClock(seconds = this.seconds(), playing = this.clock.playing): void {
    this.clock = { seconds, at: performance.now(), playing, rate: this.percent / 100 };
  }

  /**
   * A new rate widens or narrows the band and makes the engine's last report stale, so the
   * extrapolation starts again from where the clock has reached.
   */
  private rate(): void {
    this.sheet.windowTicks = windowTicksOf(this.sheet.score, this.percent);
    this.restartClock();
    if (this.loaded) void commands.previewRate(this.percent);
  }

  /** Hands the engine the piece, once per Preview. */
  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    await commands.previewLoad(this.notes);
    await commands.previewRate(this.percent);
  }

  private show(changed: Partial<PreviewShown>): void {
    this.shown = { ...this.shown, ...changed };
    for (const listen of this.listeners) listen();
  }
}
