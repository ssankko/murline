// The play screen: one 48 px bar of controls over the sheet, with the lane under it. One clock,
// one frame loop, no state of the play in React beyond what the bar has to draw.

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ENGINE_KNOBS,
  knobValues,
  LANE_KNOBS,
  set,
  setting,
  subscribe,
  type SettingKey,
} from '@/settings/settings';
import { DEFAULT_SPLIT, Lane, SPLIT_MAX, SPLIT_MIN, TOP_BAR } from '@/lane/lane';
import { baseNameOf, pathOf, readScoreFile } from '@/library/index-file';
import { setNotice } from '@/library/notice';
import {
  getPiece,
  insertPerformance,
  insertPlay,
  updatePiecePosition,
  updatePieceSettings,
  type PieceSettingValues,
} from '@/library/queries';
import { reindexIfChanged } from '@/library/scan';
import { clamp } from '@/lib/utils';
import { Collapse } from '@/look/collapse';
import { Opening } from '@/look/loading';
import { Metronome, type MetronomeHandle } from '@/look/metronome';
import { useDark } from '@/look/use-dark';
import { useMidiStatus } from '@/midi/use-midi-status';
import { click, setClickVolume } from '@/play/click';
import { ghost, ghostStrike, silenceGhosts } from '@/play/ghost';
import {
  Engine,
  type PerformanceRecord,
  type PlayKind,
  type PlayState,
} from '@/play/engine';
import { resolvePlaySettings, UNSET_PIECE_SETTINGS, type PieceSettings } from '@/play/resolve';
import {
  DEFAULT_PLAY_SETTINGS,
  type HandsSetting,
  stepTempo,
  TEMPO_KEYS,
  TEMPO_RANGE,
  tempoLabel,
  type PlayMode,
  type TempoMode,
} from '@/play/settings';
import { clampSection, savedSection, sectionLabel, type Section } from '@/play/section';
import { arrowBack, stepTarget } from '@/play/step';
import { useFrameLoop } from '@/play/use-frame-loop';
import { keyAt, type Key } from '@/score/key';
import { bpmAt, ScoreError, type Measure } from '@/score/types';
import { Button } from '@/components/ui/button';
import { BarButton, ICON, KeyPopover, TEMPO_STEP, TempoPopover } from '@/screens/bar';
import { SettingsPanel, SpacingPopup } from '@/screens/settings';
import { StatusBar } from '@/screens/status-bar';
import { useFullscreen } from '@/screens/use-fullscreen';
import { Sheet, type Pinch } from '@/sheet/sheet';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  ArrowLeft,
  FastForward,
  Hand,
  Minus,
  Pause,
  Play,
  Plus,
  Repeat,
  RotateCcw,
  Square,
  Tally4,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** Every global setting a play already on screen answers to. */
const WATCHED = [
  ...(Object.keys(ENGINE_KNOBS) as SettingKey[]),
  ...(Object.keys(LANE_KNOBS) as SettingKey[]),
  'sheet_harmony',
  'sheet_colour',
  'click_volume',
  'sheet_split',
  'sheet_proportional',
  'sheet_spacing',
] as const satisfies readonly SettingKey[];

/** The order the hands button cycles in. */
const NEXT_HANDS: Record<HandsSetting, HandsSetting> = {
  both: 'left',
  left: 'right',
  right: 'both',
};

export function PlayScreen({
  folder,
  path,
  intent = 'practice',
  onBack,
}: {
  folder: string;
  path: string;
  /** What the screen was opened for: a practice Idle, or a performance armed at bar one. */
  intent?: PlayKind;
  onBack: () => void;
}) {
  /** False once the screen is gone or the piece changed, so a late write touches no state. */
  const mounted = useRef(true);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sheetRef = useRef<Sheet | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const laneRef = useRef<Lane | null>(null);
  const metronomeRef = useRef<MetronomeHandle>(null);
  /** The engine's counters as the last frame read them: a change is what the screen answers. */
  const finishesRef = useRef(0);
  const dark = useDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const full = useFullscreen();

  const [title, setTitle] = useState(baseNameOf(path));
  /** True from the start of the open until the piece stands on the screen, and on a failure too. */
  const [opening, setOpening] = useState(true);
  const [state, setState] = useState<PlayState>('idle');
  const [kind, setKind] = useState<PlayKind>('practice');
  /** The card of the performance that just ended, with the piece's best before this run. */
  const [summary, setSummary] = useState<{ record: PerformanceRecord; best: number | null } | null>(
    null,
  );

  /** The Section and the toggle that gives it force. Both are kept with the piece. */
  const [section, setSection] = useState<Section | null>(null);
  const [loop, setLoop] = useState(false);
  const [measures, setMeasures] = useState<Measure[]>([]);
  /** The key the clock stands in, read from the measure the play stands in. */
  const [key, setKey] = useState<Key | null>(null);

  /** What a pinch on the sheet is choosing while it lasts, which the panel over the paper shows. */
  const [pinch, setPinch] = useState<Pinch | null>(null);
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsJump, setSettingsJump] = useState<string | null>(null);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [midiOpen, setMidiOpen] = useState(false);
  const [hands, setHands] = useState(DEFAULT_PLAY_SETTINGS.hands);
  /** A one-staff piece is all right hand, so it has no choice of hands to offer. */
  const [oneStaff, setOneStaff] = useState(false);

  // The piece settings the bar draws. Each one is written to the engine's live settings as it is
  // changed, so it reaches the clock on the next frame.
  const [tempoMode, setTempoMode] = useState<TempoMode>(DEFAULT_PLAY_SETTINGS.tempoMode);
  const [tempo, setTempo] = useState(DEFAULT_PLAY_SETTINGS.tempoValue);
  const [metronome, setMetronome] = useState(DEFAULT_PLAY_SETTINGS.metronome);
  /** The bar's count-in is a toggle: one bar or none. The engine counts whatever number it holds. */
  const [countInBars, setCountInBars] = useState(DEFAULT_PLAY_SETTINGS.countInBars);
  const [mode, setMode] = useState<PlayMode>(DEFAULT_PLAY_SETTINGS.mode);
  /** The score's own tempo, and whether it has only one, which is what BPM mode needs. */
  const [written, setWritten] = useState({ bpm: 120, constant: false });
  // The grade and the lane read every strike; the inactive hand reads only how hard the key went
  // down, so it can follow the player's loudness.
  const midi = useMidiStatus((event) => {
    engineRef.current?.strike(event);
    if (event.on) ghostStrike(event.velocity);
  });

  // Opening a piece: bring its index up to date in case the file changed, read the bytes, render
  // the sheet and build the Score of what was rendered. Any failure goes back to the library.
  useEffect(() => {
    mounted.current = true;
    setOpening(true);
    // One flag per run of the effect: `mounted` is shared, so a later mount puts it back up while
    // the sheet of a run that is over is still on its way.
    let live = true;
    const fileName = baseNameOf(path);
    void (async () => {
      try {
        await reindexIfChanged(folder, path);
        const bytes = await readScoreFile(pathOf(folder, path));
        const row = await getPiece(path).catch(() => null);
        const resolved = resolvePlaySettings(row ?? UNSET_PIECE_SETTINGS);
        const sheet = await Sheet.open(
          hostRef.current!,
          bytes,
          fileName,
          darkRef.current,
          setting('sheet_proportional'),
          setting('sheet_spacing'),
        );
        if (!live) return sheet.dispose();
        sheetRef.current = sheet;
        // The file may have changed since the Section was saved, so the engine is never given one
        // naming a bar this piece no longer has.
        const kept = savedSection(sheet.score.measures, resolved.sectionFrom, resolved.sectionTo);
        const settings: PieceSettings = {
          ...resolved,
          sectionFrom: kept?.from ?? null,
          sectionTo: kept?.to ?? null,
        };
        // The piece opens as it was left: its own settings over the built-in defaults, with the
        // global knobs (the grade windows, the keyboard size) between the two.
        const engine = new Engine(sheet.score, {
          ...DEFAULT_PLAY_SETTINGS,
          ...knobValues(ENGINE_KNOBS),
          ...settings,
        });
        if (intent === 'performance') engine.arm();
        engineRef.current = engine;
        // The sheet knows where a click landed; the screen decides what it means.
        sheet.onSeek = (target) => engine.seek(target);
        // A pinch has already spaced the sheet; this only stores what it settled on.
        sheet.onLook = ({ spacing }) => {
          void set('sheet_spacing', spacing);
        };
        sheet.onPinch = (moving) => setPinch(moving);
        sheet.onSection = (picked) => {
          if (engine.kind !== 'practice') return;
          changeSection(picked && clampSection(sheet.score.measures, picked));
        };
        setMeasures(sheet.score.measures);
        sheet.setLook({ harmony: setting('sheet_harmony'), colour: setting('sheet_colour') });
        const lane = knobValues(LANE_KNOBS);
        laneRef.current = new Lane(canvasRef.current!, engine, lane, darkRef.current);
        laneRef.current.onSeek = (target) => engine.seek(target);
        // A pinch has already scaled the lane; this only writes down the beats it settled on.
        laneRef.current.onLook = ({ lookaheadBeats }) => {
          if (lookaheadBeats !== undefined) void set('lane_lookahead', lookaheadBeats);
        };
        setSplit(clamp(setting('sheet_split'), SPLIT_MIN, SPLIT_MAX));
        setOneStaff(sheet.score.staffCount < 2);
        show(settings, kept);
        setOpening(false);
        // The piece reopens where it was left. The seek runs with the Section and Loop already in
        // force, so a place inside the lap wins and one outside it is pulled to the lap's start.
        // A file that lost the bars it named leaves a tick past the end, which is no place to open.
        const at = row?.position_tick;
        if (intent === 'practice' && typeof at === 'number' && at < engine.endTick) {
          engine.seek({ tick: at });
        }
        setClickVolume(setting('click_volume'));
        setWritten({
          bpm: sheet.score.hasTempo ? Math.round(bpmAt(sheet.score, 0)) : 120,
          constant: sheet.score.constantTempo,
        });
        setTitle(sheet.score.title || fileName);
      } catch (error) {
        // The play screen has no error state: the library says what went wrong instead, and only
        // a failure while this run of the screen still stands is worth a notice.
        if (!live) return;
        const reason = error instanceof ScoreError ? error.reason : String(error);
        setNotice(`Could not open ${fileName}: ${reason}`);
        setOpening(false);
        backRef.current();
      }
    })();
    return () => {
      live = false;
      mounted.current = false;
      // Leaving the screen is a stop, so the practice it ends and the place it ends at are both
      // stored on the way out.
      void savePosition();
      engineRef.current?.abort();
      // The frame loop is gone, so the note-offs the abort owes are sent from what is held instead.
      silenceGhosts();
      void savePractice();
      sheetRef.current?.dispose();
      laneRef.current?.dispose();
      sheetRef.current = null;
      engineRef.current = null;
      laneRef.current = null;
      setKey(null);
    };
  }, [folder, path, intent]);

  // Quitting is an abort like Back is, and the window waits for this handler, so the practice
  // under way reaches the database before it goes.
  useEffect(() => {
    const listening = getCurrentWindow().onCloseRequested(async () => {
      await savePosition();
      engineRef.current?.abort();
      await savePractice();
    });
    return () => void listening.then((stop) => stop(), console.error);
  }, [path]);

  useEffect(() => {
    sheetRef.current?.setDark(dark);
    laneRef.current?.setDark(dark);
  }, [dark]);

  // An unplugged cable must not run the cursor away from a player who cannot answer it. A practice
  // pauses; a performance the player cannot finish ends there.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || midi.devices.length > 0) return;
    const { state: at } = engine.snapshot();
    if (at === 'running' || at === 'counting-in') engine.pause();
  }, [midi.devices]);

  // The Section and Loop are screen state: the engine gives them force and the sheet draws them.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    engine.setSection(section);
    engine.setLoop(loop);
    sheetRef.current?.setSection(section);
  }, [section, loop]);

  /** Nothing on screen announces the save; the library's History is where it shows. */
  async function savePractice(): Promise<void> {
    const done = engineRef.current?.takePractice();
    if (!done) return;
    await insertPlay(path, 'practice', done.startedAt, done.seconds).catch(console.error);
  }

  /**
   * Where the cursor stands now, so the piece reopens there. Read before the abort that takes the
   * clock back to the start point. A performance leaves no place behind, as it writes no setting.
   */
  async function savePosition(): Promise<void> {
    const engine = engineRef.current;
    if (!engine || engine.kind === 'performance') return;
    // A count-in stands before the tick it leads to, and that tick is where the user was.
    const { state: at, playedTick, countInTo } = engine.snapshot();
    const tick = Math.round(at === 'counting-in' ? countInTo : playedTick);
    await updatePiecePosition(path, tick).catch(console.error);
  }

  /** A complete performance leaves a row, and the card that says what it earned. */
  function savePerformance(): void {
    const done = engineRef.current?.takePerformance();
    if (!done) return;
    (async () => {
      // The best is read before the row goes in, so the card holds this run against the ones before.
      const best = await getPiece(path).then(
        (row) => row?.best_grade ?? null,
        () => null,
      );
      if (mounted.current) setSummary({ record: done, best });
      await insertPerformance(path, done);
    })().catch(console.error);
  }

  /**
   * Every piece setting the bar changes goes to the piece row at once, so the piece
   * reopens as it was left. A performance hides those controls, so nothing is written during one.
   */
  function persist(values: PieceSettingValues): void {
    if (engineRef.current?.kind === 'performance') return;
    updatePieceSettings(path, values).catch(console.error);
  }

  /** Puts a resolved set of piece settings on the bar, the engine, the sheet and the keyboard. */
  function show(settings: PieceSettings, kept: Section | null): void {
    setTempoMode(settings.tempoMode);
    setTempo(settings.tempoValue);
    setMetronome(settings.metronome);
    setCountInBars(settings.countInBars);
    setHands(settings.hands);
    setMode(settings.mode);
    setLoop(settings.loop);
    setSection(kept);
    const engine = engineRef.current;
    if (!engine) return;
    Object.assign(engine.settings, settings);
    sheetRef.current?.setHands(settings.hands);
    laneRef.current?.setRange();
  }

  function changeTempo(value: number): void {
    setTempo(value);
    if (engineRef.current) engineRef.current.settings.tempoValue = value;
    persist({ tempo_value: value });
  }

  function changeCountIn(bars: number): void {
    setCountInBars(bars);
    if (engineRef.current) engineRef.current.settings.countInBars = bars;
    persist({ count_in_bars: bars });
  }

  function changeMetronome(on: boolean): void {
    setMetronome(on);
    if (engineRef.current) engineRef.current.settings.metronome = on;
    persist({ metronome: on ? 1 : 0 });
  }

  /** Wait mode takes hold from the Onset the cursor stands at; Flow lets go from there. */
  function changeMode(next: PlayMode): void {
    setMode(next);
    if (engineRef.current) engineRef.current.settings.mode = next;
    persist({ mode: next });
  }

  // The Section and Loop reach the engine through the effect that watches them, so these two only
  // move the screen's own state and write it down.

  function changeLoop(on: boolean): void {
    setLoop(on);
    persist({ loop: on ? 1 : 0 });
  }

  function changeSection(next: Section | null): void {
    setSection(next);
    persist({ section_from: next?.from ?? null, section_to: next?.to ?? null });
  }

  // Every global knob a running play reads, on the live objects the moment it is written: the
  // engine's settings, the lane's look, the sheet and the click. A pinch and the panel come the
  // same way, because both write the setting.
  useEffect(() => {
    const stops = WATCHED.map((key) =>
      subscribe(key, () => {
        const engineField = ENGINE_KNOBS[key as keyof typeof ENGINE_KNOBS];
        if (engineField && engineRef.current) {
          Object.assign(engineRef.current.settings, { [engineField]: setting(key) });
          // The keyboard size is the one engine knob the lane lays itself out from.
          if (key.startsWith('keyboard_')) laneRef.current?.setRange();
        }
        const laneField = LANE_KNOBS[key as keyof typeof LANE_KNOBS];
        if (laneField) Object.assign(laneRef.current?.look ?? {}, { [laneField]: setting(key) });
        if (key === 'sheet_harmony') sheetRef.current?.setLook({ harmony: setting(key) });
        if (key === 'sheet_colour') sheetRef.current?.setLook({ colour: setting(key) });
        if (key === 'click_volume') setClickVolume(setting(key));
        if (key === 'sheet_split') setSplit(setting(key));
        if (key === 'sheet_proportional') sheetRef.current?.setProportional(setting(key));
        if (key === 'sheet_spacing') sheetRef.current?.setSpacing(setting(key));
      }),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, []);

  useFrameLoop((delta, now) => {
    const engine = engineRef.current;
    const sheet = sheetRef.current;
    const lane = laneRef.current;
    if (!engine || !sheet || !lane) return;
    // Strikes carry the plugin's Unix timestamp, so the clock takes wall time on the same
    // timeline. The lane runs on it too: it ages its feedback against the engine's own stamps.
    const wall = performance.timeOrigin + now;
    engine.advance(delta, wall);
    // Every owed beat is one click, and the icon reads the last of them.
    const owed = engine.beats();
    for (const strength of owed) click(strength);
    if (owed.length > 0) {
      metronomeRef.current?.tick(owed[owed.length - 1] === 'strong', engine.beatMs);
    }
    for (const note of engine.ghosts()) ghost(note, engine.settings);
    void savePractice();
    savePerformance();
    const snapshot = engine.snapshot();
    if (engine.finishes !== finishesRef.current) {
      finishesRef.current = engine.finishes;
      sheet.finish();
    }
    for (const event of engine.events()) lane.effect(event, wall);
    sheet.setWalk(engine.walk);
    // The sheet is a projection of the engine: it draws the note states, never a copy of them.
    sheet.project(engine, snapshot.playedTick);
    sheet.frame(snapshot, engine.windowTicks, now);
    lane.notice = midi.devices.length === 0 ? 'no MIDI device' : null;
    const inForce = keyAt(engine.score, snapshot.measureIndex);
    lane.frame(snapshot, inForce, engine.windowTicks, wall);
    if (inForce !== key) setKey(inForce);
    if (snapshot.state !== state) {
      setState(snapshot.state);
      // The card belongs to the run that ended; anything that moves the play again takes it away.
      if (snapshot.state !== 'ended') setSummary(null);
    }
    if (snapshot.kind !== kind) setKind(snapshot.kind);
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      // The settings dialog and every popover are `role="dialog"`: while one is open the keys are
      // its own and never reach the clock.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      const tempoStep = TEMPO_KEYS[event.code];
      if (event.key === ' ') {
        event.preventDefault();
        toggle();
      } else if (tempoStep) {
        // Only a practice takes a tempo key; a performance keeps the tempo it was armed at.
        const engine = engineRef.current;
        if (engine?.kind !== 'practice') return;
        const { tempoValue, tempoMode: mode } = engine.settings;
        changeTempo(stepTempo(tempoValue, tempoStep, event.shiftKey, mode));
      } else if (event.key.startsWith('Arrow')) {
        // Only a practice moves by the arrows; a performance is one clean run.
        const engine = engineRef.current;
        if (engine?.kind !== 'practice') return;
        // The pointer says which arrows act: over the falling notes, over the sheet, or elsewhere.
        const area = canvasRef.current?.matches(':hover')
          ? 'lane'
          : hostRef.current?.matches(':hover')
            ? 'sheet'
            : null;
        const back = arrowBack(event.key, area);
        if (back === null) return;
        event.preventDefault();
        const to = stepTarget(
          engine.score,
          engine.walk,
          engine.snapshot().playedTick,
          back,
          event.shiftKey,
        );
        if (to) engine.seek(to);
      } else if (event.key === 'Escape') {
        // Escape clears the Section only in a practice that is already still; every other play,
        // an armed performance included, it aborts.
        const engine = engineRef.current;
        if (engine?.kind === 'practice' && engine.snapshot().state === 'idle') changeSection(null);
        else engine?.abort();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // Escape writes the cleared Section down, so the handler must hold the piece on screen now.
  }, [path]);

  /** Play and pause are the same key and the same disc, whatever the play is doing. */
  function toggle(): void {
    const engine = engineRef.current;
    if (!engine) return;
    const { state: at } = engine.snapshot();
    // Pausing a count-in drops the play back to Idle, so the same key stops it as stops the clock.
    if (at === 'running' || at === 'counting-in') engine.pause();
    else if (at === 'paused') engine.resume();
    // Marks and colours of the last run stay on the sheet until the engine opens the notes again,
    // and the inactive hand learns the player's loudness again from this run's own strikes.
    else {
      silenceGhosts();
      engine.start();
    }
  }

  /** The next hands setting, on the engine and on the sheet; the lane reads the engine itself. */
  function cycleHands(): void {
    const engine = engineRef.current;
    if (!engine) return;
    const next = NEXT_HANDS[engine.settings.hands];
    engine.settings.hands = next;
    sheetRef.current?.setHands(next);
    setHands(next);
    persist({ hands: next });
  }

  /** Perform arms a performance; Stop takes it off, running or not, and it leaves no row. */
  function togglePerform(): void {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.kind === 'performance') engine.abort();
    else engine.arm();
  }

  const performing = kind === 'performance';
  const running = state === 'running' || state === 'counting-in';
  const [tempoMin, tempoMax] = TEMPO_RANGE[tempoMode];
  const nudgeTempo = (by: number) => changeTempo(clamp(tempo + by, tempoMin, tempoMax));

  /** The two modes read the same piece at the same speed, so a switch carries the value over. */
  function switchMode(next: TempoMode): void {
    if (next === tempoMode) return;
    const [min, max] = TEMPO_RANGE[next];
    const written100 = next === 'bpm' ? (written.bpm * tempo) / 100 : (tempo / written.bpm) * 100;
    const value = clamp(Math.round(written100), min, max);
    setTempoMode(next);
    setTempo(value);
    if (engineRef.current) {
      Object.assign(engineRef.current.settings, { tempoMode: next, tempoValue: value });
    }
    persist({ tempo_mode: next, tempo_value: value });
  }

  return (
    <TooltipProvider>
      <div className="bg-chrome fixed inset-0 flex flex-col">
        {/* Fullscreen hides the traffic lights, so the gap kept for them folds away. */}
        <div
          className={`border-edge-soft relative flex h-12 flex-none items-center gap-0.5 border-b pr-2 ${full ? 'pl-2' : 'pl-20'} transition-[padding] duration-200 ease-[var(--ease)] motion-reduce:transition-none`}
          data-tauri-drag-region
        >
          <BarButton label="Back to library" onClick={onBack}>
            <ArrowLeft {...ICON} />
          </BarButton>
          <b className="pointer-events-none ml-1.5 mr-1 min-w-0 truncate text-[13px] font-medium">{title}</b>
          <KeyPopover at={key} />

          {/* The play disc keeps the window's midline whatever the two sides hold. */}
          <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5">
            <BarButton
              label="Count-in"
              pressed={countInBars > 0}
              onClick={() => changeCountIn(countInBars > 0 ? 0 : 1)}
            >
              <Tally4 {...ICON} />
            </BarButton>
            <Collapse axis="x" open={!performing}>
              <BarButton label="Restart" onClick={() => engineRef.current?.restart()}>
                <RotateCcw {...ICON} />
              </BarButton>
            </Collapse>
            <BarButton label={running ? 'Pause' : 'Play'} disc onClick={toggle}>
              {running ? <Pause {...ICON} /> : <Play {...ICON} />}
            </BarButton>
            <Collapse axis="x" open={!performing}>
              <BarButton
                label={sectionLabel(measures, section)}
                pressed={loop}
                onClick={() => changeLoop(!loop)}
              >
                <Repeat {...ICON} />
              </BarButton>
            </Collapse>
            <BarButton
              label="Metronome"
              pressed={metronome}
              onClick={() => changeMetronome(!metronome)}
            >
              <Metronome {...ICON} ref={metronomeRef} on={metronome} />
            </BarButton>
          </div>

          <div className="ml-auto flex items-center">
            {/* A performance runs at one tempo, one hands setting and in Flow, so they all fold
                away, their own gap with them. */}
            <Collapse axis="x" open={!performing}>
              <div className="flex items-center gap-2.5 pr-2.5">
                <div className="flex items-center">
                  <BarButton label="Slower" onClick={() => nudgeTempo(-TEMPO_STEP)}>
                    <Minus {...ICON} />
                  </BarButton>
                  <TempoPopover
                    mode={tempoMode}
                    value={tempo}
                    constantTempo={written.constant}
                    onMode={switchMode}
                    onValue={changeTempo}
                  />
                  <BarButton label="Faster" onClick={() => nudgeTempo(TEMPO_STEP)}>
                    <Plus {...ICON} />
                  </BarButton>
                </div>
                {/* The left glyph is the left hand; the hand the play does not expect is dimmed. */}
                <BarButton label={`Hands: ${hands}`} off={oneStaff} onClick={cycleHands} wide>
                  <Hand {...ICON} className={handGlyph(hands, 'left')} />
                  <Hand {...ICON} className={`scale-x-[-1] ${handGlyph(hands, 'right')}`} />
                </BarButton>
                <div className="border-ink/55 divide-ink/55 flex items-center divide-x overflow-hidden rounded-md border">
                  <BarButton
                    label="Flow mode"
                    segment
                    pressed={mode === 'flow'}
                    onClick={() => changeMode('flow')}
                  >
                    <FastForward {...ICON} />
                  </BarButton>
                  <BarButton
                    label="Wait mode"
                    segment
                    pressed={mode === 'wait'}
                    onClick={() => changeMode('wait')}
                  >
                    <Hand {...ICON} />
                  </BarButton>
                </div>
              </div>
            </Collapse>
            {/* The only outlined control: an outline arms a performance, a fill stops one. */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={performing ? 'Stop' : 'Perform'}
                  onClick={togglePerform}
                  className={`flex h-[30px] flex-none items-center gap-1.5 rounded-md border px-3.5 text-[13px] font-medium transition-colors duration-150 ${
                    performing
                      ? 'border-ink bg-ink text-paper hover:bg-ink/85'
                      : 'border-ink/55 hover:bg-ink/8'
                  }`}
                >
                  {performing && <Square size={11} strokeWidth={0} className="fill-current" />}
                  {performing ? 'Stop' : 'Perform'}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {performing ? 'Stop the performance' : 'Perform'}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div ref={hostRef} className="bg-paper min-h-0" style={{ flex: `${split} 1 0` }} />
        <Split value={split} onChange={setSplit} />
        <div className="bg-paper relative min-h-0" style={{ flex: `${1 - split} 1 0` }}>
          <canvas ref={canvasRef} className="block h-full w-full" />
          {state === 'ended' && summary && (
            <Summary
              record={summary.record}
              best={summary.best}
              onAgain={toggle}
              onClose={() => engineRef.current?.arm()}
            />
          )}
        </div>

        {/* After the sheet and the lane, so the row stands over both of them. */}
        <Opening on={opening} name={title} />

        <StatusBar
          midiOpen={midiOpen}
          onMidiOpen={setMidiOpen}
          mixerOpen={mixerOpen}
          onMixerOpen={setMixerOpen}
          onOpenSettings={() => setSettingsOpen(true)}
          onSoundSettings={() => {
            setSettingsJump('instrument_id');
            setSettingsOpen(true);
          }}
        />

        <SpacingPopup pinch={pinch} />

        <SettingsPanel
          open={settingsOpen}
          jumpTo={settingsJump}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsJump(null);
          }}
          onOpenMixer={() => setMixerOpen(true)}
          onOpenMidi={() => setMidiOpen(true)}
        />
      </div>
    </TooltipProvider>
  );
}

/**
 * What the performance earned, over the lane with the sheet and its marks still behind it. The
 * headline is the grade; the line under it says what this run is being held against.
 */
function Summary({
  record,
  best,
  onAgain,
  onClose,
}: {
  record: PerformanceRecord;
  /** The piece's best grade before this run, `null` when this is its first graded one. */
  best: number | null;
  onAgain: () => void;
  onClose: () => void;
}) {
  const grade = record.grade;
  const hitRate =
    grade && grade.expected > 0 ? Math.round((100 * grade.matched) / grade.expected) : null;
  const tempo = tempoLabel(record.tempoMode, record.tempoValue);
  return (
    <div className="bg-paper/95 animate-in fade-in-0 absolute inset-0 flex flex-col items-center justify-center gap-6 duration-200">
      <div className="text-[64px] leading-none font-semibold tabular-nums">
        {grade ? grade.grade : '—'}
      </div>
      <dl className="flex gap-8">
        <Cell label="Hit rate" value={hitRate === null ? '—' : `${hitRate} %`} />
        <Cell label="Timing" value={grade?.meanTiming ?? '—'} />
        <Cell label="Velocity" value={grade?.meanVelocity ?? '—'} />
        <Cell label="Release" value={grade?.meanRelease ?? '—'} />
        <Cell label="Extras" value={grade?.extras ?? '—'} />
      </dl>
      <p className="text-muted-ink text-[12px]">
        best <span className="tabular-nums">{best ?? '—'}</span>
        <span> · </span>
        <span className="tabular-nums">{tempo}</span>
        <span> · hands {record.hands}</span>
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={onAgain}>
          Play again
        </Button>
        <Button size="sm" variant="outline" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

/** One number of the breakdown, muted label over value like the library's facts strip. */
function Cell({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <dt className="text-muted-ink text-[11px]">{label}</dt>
      <dd className="text-[15px] font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/** A hand the play does not expect is dimmed, and fades as the setting changes. */
function handGlyph(hands: HandsSetting, hand: 'left' | 'right'): string {
  return `transition-opacity duration-200 ${hands === 'both' || hands === hand ? '' : 'opacity-30'}`;
}

/**
 * The hairline between sheet and lane: a 9 px hit area over a 1 px line, with a pill to say it can
 * be dragged. Dragging it shows more or fewer beats and never changes the beat scale.
 */
function Split({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.buttons === 0) return;
    const share = (event.clientY - TOP_BAR) / Math.max(window.innerHeight - TOP_BAR, 1);
    onChange(clamp(share, SPLIT_MIN, SPLIT_MAX));
  };
  return (
    <div
      role="separator"
      aria-label="Sheet and lane split"
      className="group relative h-[9px] flex-none cursor-row-resize"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag(event);
      }}
      onPointerMove={drag}
      onPointerUp={() => void set('sheet_split', value)}
    >
      <i className="bg-edge-soft absolute inset-x-0 top-1 block h-px" />
      <i className="bg-edge group-hover:bg-muted-ink absolute top-[2px] left-1/2 block h-[5px] w-9 -translate-x-1/2 rounded-full transition-colors duration-150" />
    </div>
  );
}
