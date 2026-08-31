// One play of one piece: the engine, the two views, the inactive hand, the metronome, the frame
// routing and everything the piece row is written from. The screen hands it a delta, a strike and
// the theme, reads one snapshot out of it and draws; nothing of the play lives in React.

import { Lane } from '@/lane/lane';
import { openPiece } from '@/library/open-piece';
import {
  getPiece,
  insertPerformance,
  insertPlay,
  PIECE_SETTING_COLUMNS,
  updatePiecePosition,
  updatePieceSettings,
  type PieceSettingValues,
} from '@/library/queries';
import { Click } from '@/play/click';
import {
  Engine,
  type PerformanceRecord,
  type PlayKind,
  type PlayState,
  type SeekTarget,
  type StrikeEvent,
} from '@/play/engine';
import { Ghosts } from '@/play/ghost';
import { savedSection, type Section } from '@/play/section';
import { resolvePlaySettings, UNSET_PIECE_SETTINGS, type PieceSettings } from '@/play/resolve';
import { DEFAULT_PLAY_SETTINGS, type PlaySettings } from '@/play/settings';
import { stepTarget } from '@/play/step';
import type { LaneView, PlayView, SheetView } from '@/play/view';
import { keyAt, type Key } from '@/score/key';
import { bpmAt, type Measure, type Score } from '@/score/types';
import {
  ENGINE_KNOBS,
  knobValues,
  LANE_KNOBS,
  setting,
  subscribe,
  type SettingKey,
} from '@/settings/settings';
import { Sheet } from '@/sheet/sheet';
import type { Pinch } from '@/sheet/pinch';

/** Every global setting a play already on screen answers to. */
const WATCHED = [
  ...(Object.keys(ENGINE_KNOBS) as SettingKey[]),
  ...(Object.keys(LANE_KNOBS) as SettingKey[]),
  'sheet_harmony',
  'sheet_colour',
  'click_volume',
  'sheet_proportional',
  'sheet_spacing',
] as const satisfies readonly SettingKey[];

/** Everything the screen draws of a play. One object, replaced whenever any of it changes. */
export interface PlayShown {
  state: PlayState;
  kind: PlayKind;
  /** The key the clock stands in, read from the measure it stands in. */
  key: Key | null;
  /** The piece settings the bar draws, and the Section as two bar indices. */
  settings: PieceSettings;
  section: Section | null;
  /** The score's own tempo, and whether it has only one, which is what BPM mode needs. */
  written: { bpm: number; constant: boolean };
  /** The card of the performance that just ended, with the piece's best before this run. */
  summary: { record: PerformanceRecord; best: number | null } | null;
  /** What a pinch on the sheet is choosing while it lasts. */
  pinch: Pinch | null;
  /** The score's title, empty until a piece is open. */
  title: string;
  measures: Measure[];
  /** A one-staff piece is all right hand, so it has no choice of hands to offer. */
  oneStaff: boolean;
}

/** What a play stands on before one is open, which is what the screen draws while it opens. */
export const NO_PLAY: PlayShown = {
  state: 'idle',
  kind: 'practice',
  key: null,
  settings: resolvePlaySettings(UNSET_PIECE_SETTINGS),
  section: null,
  written: { bpm: 120, constant: false },
  summary: null,
  pinch: null,
  title: '',
  measures: [],
  oneStaff: false,
};

/** What one play is built from: the piece it plays, what it plays it on, and where it draws. */
export interface PlayOptions {
  path: string;
  score: Score;
  /** The piece's own settings over the built-in defaults. */
  resolved: PieceSettings;
  /** What the play was opened for: a practice Idle, or a performance armed at bar one. */
  intent: PlayKind;
  dark: boolean;
  sheet: SheetView;
  lane: LaneView;
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  /** Played tick the piece was left at, which a practice reopens at. */
  at?: number | null;
}

export class Play {
  readonly path: string;
  /** The metronome icon's own beat: the screen hangs its animation on this. */
  showBeat: ((strong: boolean, beatMs: number) => void) | null = null;

  private readonly engine: Engine;
  private readonly sheet: SheetView;
  private readonly lane: LaneView;
  private readonly ghosts = new Ghosts();
  private readonly click: Click;
  /** Takes this play off every global setting it answers to. */
  private readonly stops: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private shown: PlayShown;
  private dark: boolean;
  /** The engine's finish counter as the last frame read it: a change is what the sheet animates. */
  private finished = 0;
  /** False once the play is left, so an answer still on its way touches nothing. */
  private live = true;

  /**
   * Opens the piece, renders its sheet, and builds the play over it. Every failure of the open
   * throws, and the screen says what went wrong.
   */
  static async open(o: {
    folder: string;
    path: string;
    intent: PlayKind;
    dark: boolean;
    host: HTMLElement;
    canvas: HTMLCanvasElement;
  }): Promise<Play> {
    const { bytes, fileName, row, resolved } = await openPiece(o.folder, o.path);
    const sheet = await Sheet.load(
      o.host,
      bytes,
      fileName,
      o.dark,
      setting('sheet_proportional'),
      setting('sheet_spacing'),
    );
    return new Play({
      path: o.path,
      score: sheet.score,
      resolved,
      intent: o.intent,
      dark: o.dark,
      sheet,
      lane: new Lane(knobValues(LANE_KNOBS), o.dark),
      host: o.host,
      canvas: o.canvas,
      at: row?.position_tick,
    });
  }

  constructor(o: PlayOptions) {
    this.path = o.path;
    this.sheet = o.sheet;
    this.lane = o.lane;
    this.dark = o.dark;
    // The file may have changed since the Section was saved, so the engine is never given one
    // naming a bar this piece no longer has.
    const kept = savedSection(o.score.measures, o.resolved.sectionFrom, o.resolved.sectionTo);
    // The piece opens as it was left: its own settings over the built-in defaults, with the global
    // knobs (the grade windows, the keyboard size) between the two.
    this.engine = new Engine(o.score, {
      ...DEFAULT_PLAY_SETTINGS,
      ...knobValues(ENGINE_KNOBS),
      ...o.resolved,
      sectionFrom: kept?.from ?? null,
      sectionTo: kept?.to ?? null,
    });
    if (o.intent === 'performance') this.engine.arm();
    this.click = new Click(setting('click_volume'));
    this.shown = {
      ...NO_PLAY,
      kind: this.engine.kind,
      settings: this.pieceSettings(),
      section: this.engine.section,
      written: {
        bpm: o.score.hasTempo ? Math.round(bpmAt(o.score, 0)) : 120,
        constant: o.score.constantTempo,
      },
      title: o.score.title,
      measures: o.score.measures,
      oneStaff: o.score.staffCount < 2,
    };
    // What both views read the play through. The Engine is the view already, save for the Section:
    // a change to it must reach the piece row and the screen, so that one call comes back here.
    // A Proxy and not a prototype over the engine, because the engine writes to itself and those
    // writes have to land on it, not on the object standing in front of it.
    const view: PlayView = new Proxy(this.engine, {
      get: (engine, key) =>
        key === 'setSection'
          ? (section: Section | null) => this.setSection(section)
          : Reflect.get(engine, key, engine),
    });
    this.sheet.open(view, o.host);
    this.sheet.setLook({ harmony: setting('sheet_harmony'), colour: setting('sheet_colour') });
    this.lane.open(view, o.canvas);
    // The piece reopens where it was left. The seek runs with the Section and Loop already in
    // force, so a place inside the lap wins and one outside it is pulled to the lap's start. A file
    // that lost the bars it named leaves a tick past the end, which is no place to open.
    if (o.intent === 'practice' && typeof o.at === 'number' && o.at < this.engine.endTick) {
      this.engine.seek({ tick: o.at });
    }
    for (const key of WATCHED) this.stops.push(subscribe(key, () => this.global(key)));
  }

  /** What React draws, and the subscription that says it changed. */
  snapshot(): PlayShown {
    return this.shown;
  }

  subscribe(listen: () => void): () => void {
    this.listeners.add(listen);
    return () => {
      this.listeners.delete(listen);
    };
  }

  /**
   * One animation frame: the clock moves, everything it owes is handed out, and both views draw
   * the same tick.
   */
  frame(delta: number, now: number): void {
    // A play that has been left keeps no views to draw on.
    if (!this.live) return;
    // Strikes carry the plugin's Unix timestamp, so the clock takes wall time on the same
    // timeline. The lane runs on it too: it ages its feedback against the engine's own stamps.
    const wall = performance.timeOrigin + now;
    this.engine.advance(delta, wall);
    // Every owed beat is one click, and the icon reads the last of them.
    const owed = this.engine.beats();
    for (const strength of owed) this.click.play(strength);
    if (owed.length > 0) {
      this.showBeat?.(owed[owed.length - 1] === 'strong', this.engine.beatMs);
    }
    for (const note of this.engine.ghosts()) this.ghosts.note(note, this.engine.settings);
    void this.savePractice();
    this.savePerformance();
    const snap = this.engine.snapshot();
    if (this.engine.finishes !== this.finished) {
      this.finished = this.engine.finishes;
      this.sheet.finish();
    }
    // The paper draws the note states, not the strikes, so only the lane hears the events.
    for (const event of this.engine.events()) this.lane.effect(event, wall);
    this.sheet.frame(snap, now, wall);
    this.lane.frame(snap, now, wall);

    const changed: Partial<PlayShown> = {};
    const key = keyAt(this.engine.score, snap.measureIndex);
    if (key !== this.shown.key) changed.key = key;
    if (snap.state !== this.shown.state) {
      changed.state = snap.state;
      // The card belongs to the run that ended; anything that moves the play again takes it away.
      if (snap.state !== 'ended') changed.summary = null;
    }
    if (snap.kind !== this.shown.kind) changed.kind = snap.kind;
    if (this.sheet.pinching !== this.shown.pinch) changed.pinch = this.sheet.pinching;
    if (Object.keys(changed).length > 0) this.show(changed);
  }

  /** The grade and the lane read every strike; the inactive hand reads how hard the key went down. */
  strike(event: StrikeEvent): void {
    this.engine.strike(event);
    if (event.on) this.ghosts.strike(event.velocity);
  }

  setDark(dark: boolean): void {
    if (dark === this.dark) return;
    this.dark = dark;
    this.sheet.setDark(dark);
    this.lane.setDark(dark);
  }

  /**
   * How many MIDI inputs the app has. An unplugged cable must not run the cursor away from a
   * player who cannot answer it: a practice pauses, and a performance the player cannot finish
   * ends there.
   */
  setDevices(count: number): void {
    this.lane.notice = count === 0 ? 'no MIDI device' : null;
    if (count > 0) return;
    const { state } = this.engine.snapshot();
    if (state === 'running' || state === 'counting-in') this.engine.pause();
  }

  /**
   * The one door for the settings of a play. Every piece setting among them goes to the piece row
   * at once, so the piece reopens as it was left; a performance writes nothing, as it hides the
   * controls that change these.
   */
  set(values: Partial<PlaySettings>): void {
    Object.assign(this.engine.settings, values);
    // A Section change re-applies the Loop, which is what swaps the walk the clock runs.
    if ('sectionFrom' in values || 'sectionTo' in values) {
      this.engine.setSection(this.engine.section);
    }
    if ('loop' in values) this.engine.setLoop(this.engine.settings.loop);
    // The keyboard size is the one setting the lane lays itself out from.
    if ('keyboardPreset' in values || 'keyboardLo' in values || 'keyboardHi' in values) {
      this.lane.setRange();
    }
    const columns = columnsOf(values);
    if (Object.keys(columns).length === 0) return;
    if (this.engine.kind === 'practice') {
      updatePieceSettings(this.path, columns).catch(console.error);
    }
    this.show({ settings: this.pieceSettings(), section: this.engine.section });
  }

  /** A drag on the paper picks the Section; a performance runs the whole piece and takes none. */
  setSection(section: Section | null): void {
    if (this.engine.kind !== 'practice') return;
    this.set({ sectionFrom: section?.from ?? null, sectionTo: section?.to ?? null });
  }

  seek(target: SeekTarget): void {
    this.engine.seek(target);
  }

  /** Play and pause are the same key and the same disc, whatever the play is doing. */
  toggle(): void {
    const { state } = this.engine.snapshot();
    // Pausing a count-in drops the play back to Idle, so the same key stops it as stops the clock.
    if (state === 'running' || state === 'counting-in') this.engine.pause();
    else if (state === 'paused') this.engine.resume();
    // Marks and colours of the last run stay on the sheet until the engine opens the notes again,
    // and the inactive hand learns the player's loudness again from this run's own strikes.
    else {
      this.ghosts.silence();
      this.engine.start();
    }
  }

  restart(): void {
    this.engine.restart();
  }

  /** Perform arms a performance; the stop takes it off, running or not, and it leaves no row. */
  arm(): void {
    this.engine.arm();
  }

  abort(): void {
    this.engine.abort();
  }

  /** One arrow key: the Onset or the bar one step away, back or on, near or far. */
  step(back: boolean, far: boolean): void {
    if (this.engine.kind !== 'practice') return;
    const to = stepTarget(
      this.engine.score,
      this.engine.walk,
      this.engine.snapshot().playedTick,
      back,
      far,
    );
    if (to) this.engine.seek(to);
  }

  /**
   * Leaving is a stop: the place the cursor stands and the practice it ends are both stored on the
   * way out, and nothing of this play is left drawing or sounding. The window closing calls it too.
   */
  async leave(): Promise<void> {
    this.live = false;
    // Read before the abort, which takes the clock back to the start point.
    const position = this.savePosition();
    this.engine.abort();
    // No frame runs again, so the note-offs the abort owes are sent from what is held instead.
    this.ghosts.silence();
    const practice = this.savePractice();
    this.sheet.dispose();
    this.lane.dispose();
    for (const stop of this.stops) stop();
    await position;
    await practice;
  }

  /** Nothing on screen announces the save; the library's History is where it shows. */
  private async savePractice(): Promise<void> {
    const done = this.engine.takePractice();
    if (!done) return;
    await insertPlay(this.path, 'practice', done.startedAt, done.seconds).catch(console.error);
  }

  /**
   * Where the cursor stands now, so the piece reopens there. A performance leaves no place behind,
   * as it writes no setting.
   */
  private async savePosition(): Promise<void> {
    if (this.engine.kind === 'performance') return;
    // A count-in stands before the tick it leads to, and that tick is where the user was.
    const { state, playedTick, countInTo } = this.engine.snapshot();
    const tick = Math.round(state === 'counting-in' ? countInTo : playedTick);
    await updatePiecePosition(this.path, tick).catch(console.error);
  }

  /** A complete performance leaves a row, and the card that says what it earned. */
  private savePerformance(): void {
    const done = this.engine.takePerformance();
    if (!done) return;
    void (async () => {
      // The best is read before the row goes in, so the card holds this run against the ones before.
      const best = await getPiece(this.path).then(
        (row) => row?.best_grade ?? null,
        () => null,
      );
      if (this.live) this.show({ summary: { record: done, best } });
      await insertPerformance(this.path, done);
    })().catch(console.error);
  }

  /** One global setting changed, on the live objects that read it. */
  private global(key: SettingKey): void {
    const engineField = ENGINE_KNOBS[key as keyof typeof ENGINE_KNOBS];
    if (engineField) this.set({ [engineField]: setting(key) } as Partial<PlaySettings>);
    const laneField = LANE_KNOBS[key as keyof typeof LANE_KNOBS];
    if (laneField) Object.assign(this.lane.look, { [laneField]: setting(key) });
    if (key === 'sheet_harmony') this.sheet.setLook({ harmony: setting(key) });
    if (key === 'sheet_colour') this.sheet.setLook({ colour: setting(key) });
    if (key === 'click_volume') this.click.setVolume(setting(key));
    if (key === 'sheet_proportional') this.sheet.setProportional(setting(key));
    if (key === 'sheet_spacing') this.sheet.setSpacing(setting(key));
  }

  private pieceSettings(): PieceSettings {
    const settings = this.engine.settings;
    return Object.fromEntries(
      Object.keys(PIECE_SETTING_COLUMNS).map((field) => [field, settings[field as keyof PieceSettings]]),
    ) as PieceSettings;
  }

  private show(changed: Partial<PlayShown>): void {
    this.shown = { ...this.shown, ...changed };
    for (const listen of this.listeners) listen();
  }
}

/** The piece columns a settings change writes, with the two booleans as the 0 and 1 they store. */
function columnsOf(values: Partial<PlaySettings>): PieceSettingValues {
  const columns: Record<string, unknown> = {};
  for (const [field, column] of Object.entries(PIECE_SETTING_COLUMNS)) {
    if (!(field in values)) continue;
    const value = values[field as keyof PlaySettings];
    columns[column] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
  }
  return columns as PieceSettingValues;
}
