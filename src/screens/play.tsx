// The play screen: one 48 px bar of controls over the sheet, with the lane under it. One clock,
// one frame loop, no state of the play in React beyond what the bar has to draw.

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  ENGINE_KNOBS,
  knobValues,
  LANE_KNOBS,
  readSettings,
  setSetting,
} from '@/db/db';
import { DEFAULT_SPLIT, Lane, SPLIT_MAX, SPLIT_MIN, TOP_BAR } from '@/lane/lane';
import { baseNameOf, pathOf, readScoreFile } from '@/library/index-file';
import { setNotice } from '@/library/notice';
import {
  getPiece,
  insertPerformance,
  insertPlay,
  updatePieceSettings,
  type PieceSettingValues,
} from '@/library/queries';
import { reindexIfChanged } from '@/library/scan';
import { clamp } from '@/lib/utils';
import { Collapse } from '@/look/collapse';
import { Metronome, type MetronomeHandle } from '@/look/metronome';
import { useDark } from '@/look/use-dark';
import { useMidiStatus } from '@/midi/use-midi-status';
import { click, setClickVolume } from '@/play/click';
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
  TEMPO_RANGE,
  tempoLabel,
  type PlayMode,
  type TempoMode,
} from '@/play/settings';
import { clampSection, sectionLabel, type Section } from '@/play/section';
import { useFrameLoop } from '@/play/use-frame-loop';
import { bpmAt, ScoreError, type Measure } from '@/score/types';
import { Button } from '@/components/ui/button';
import { Mixer } from '@/audio/mixer';
import { SettingsPanel, SpacingPopup, type SettingChange } from '@/screens/settings';
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
  SlidersHorizontal,
  Square,
  Tally4,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** One size and one stroke for every icon in the bar. */
const ICON = { size: 18, strokeWidth: 1.75 } as const;

/** The order the hands button cycles in. */
const NEXT_HANDS: Record<HandsSetting, HandsSetting> = {
  both: 'left',
  left: 'right',
  right: 'both',
};

/** The stepper's step. */
const TEMPO_STEP = 5;

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

  const [title, setTitle] = useState(baseNameOf(path));
  const [state, setState] = useState<PlayState>('idle');
  const [kind, setKind] = useState<PlayKind>('practice');
  /** The card of the performance that just ended, with the piece's best before this run. */
  const [summary, setSummary] = useState<{ record: PerformanceRecord; best: number | null } | null>(
    null,
  );

  /** The Section and the toggle that gives it force. Both die with the screen. */
  const [section, setSection] = useState<Section | null>(null);
  const [loop, setLoop] = useState(false);
  const [measures, setMeasures] = useState<Measure[]>([]);

  /** What a pinch on the sheet is choosing while it lasts, which the panel over the paper shows. */
  const [pinch, setPinch] = useState<Pinch | null>(null);
  /** The setting the pinch under way is moving, so the settings panel's row moves with it. */
  const [live, setLive] = useState<SettingChange | null>(null);
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsJump, setSettingsJump] = useState<string | null>(null);
  const [mixerOpen, setMixerOpen] = useState(false);
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
  /** A mode clicked before the sheet loads has no engine to reach, so the new one opens in it. */
  const modeRef = useRef<PlayMode>(DEFAULT_PLAY_SETTINGS.mode);
  /** The score's own tempo, and whether it has only one, which is what BPM mode needs. */
  const [written, setWritten] = useState({ bpm: 120, constant: false });
  const midi = useMidiStatus((event) => engineRef.current?.strike(event));

  // Opening a piece: bring its index up to date in case the file changed, read the bytes, render
  // the sheet and build the Score of what was rendered. Any failure goes back to the library.
  useEffect(() => {
    mounted.current = true;
    // One flag per run of the effect: `mounted` is shared, so a later mount puts it back up while
    // the sheet of a run that is over is still on its way.
    let live = true;
    const fileName = baseNameOf(path);
    void (async () => {
      try {
        await reindexIfChanged(folder, path);
        const bytes = await readScoreFile(pathOf(folder, path));
        const [globals, row] = await Promise.all([readSettings(), getPiece(path).catch(() => null)]);
        const resolved = resolvePlaySettings(row ?? UNSET_PIECE_SETTINGS);
        const sheet = await Sheet.open(
          hostRef.current!,
          bytes,
          fileName,
          darkRef.current,
          globals.sheet_proportional,
          globals.sheet_spacing,
        );
        if (!live) return sheet.dispose();
        sheetRef.current = sheet;
        // The piece opens as it was left: its own settings over the built-in defaults, with the
        // global knobs (the grade windows, the keyboard size) between the two.
        const engine = new Engine(sheet.score, {
          ...DEFAULT_PLAY_SETTINGS,
          ...knobValues(globals, ENGINE_KNOBS),
          mode: modeRef.current,
          ...resolved,
        });
        if (intent === 'performance') engine.arm();
        engineRef.current = engine;
        // The sheet knows where a click landed; the screen decides what it means.
        sheet.onSeek = (target) => engine.seek(target);
        // A pinch has already spaced the sheet; this only stores what it settled on.
        sheet.onLook = ({ spacing }) => {
          setSetting('sheet_spacing', spacing).catch(console.error);
        };
        sheet.onPinch = (moving) => {
          setPinch(moving);
          if (moving) setLive(['sheet_spacing', moving.spacing]);
        };
        sheet.onSection = (picked) => {
          if (engine.kind !== 'practice') return;
          setSection(picked && clampSection(sheet.score.measures, picked));
        };
        setMeasures(sheet.score.measures);
        sheet.setLook({ harmony: globals.sheet_harmony, colour: globals.sheet_colour });
        const lane = knobValues(globals, LANE_KNOBS);
        laneRef.current = new Lane(canvasRef.current!, engine, lane, darkRef.current);
        laneRef.current.onSeek = (target) => engine.seek(target);
        // A pinch has already scaled the lane; this only writes down the beats it settled on.
        laneRef.current.onLook = ({ lookaheadBeats }) => {
          if (lookaheadBeats !== undefined) changeLook('lane_lookahead', lookaheadBeats);
        };
        laneRef.current.onPinch = (lookaheadBeats) => setLive(['lane_lookahead', lookaheadBeats]);
        setSplit(clamp(globals.sheet_split, SPLIT_MIN, SPLIT_MAX));
        setOneStaff(sheet.score.staffCount < 2);
        show(resolved);
        setClickVolume(globals.click_volume);
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
        backRef.current();
      }
    })();
    return () => {
      live = false;
      mounted.current = false;
      // Leaving the screen is a stop, so the practice it ends is stored on the way out.
      engineRef.current?.abort();
      void savePractice();
      sheetRef.current?.dispose();
      laneRef.current?.dispose();
      sheetRef.current = null;
      engineRef.current = null;
      laneRef.current = null;
    };
  }, [folder, path, intent]);

  // Quitting is an abort like Back is, and the window waits for this handler, so the practice
  // under way reaches the database before it goes.
  useEffect(() => {
    const listening = getCurrentWindow().onCloseRequested(async () => {
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
  function show(settings: PieceSettings): void {
    setTempoMode(settings.tempoMode);
    setTempo(settings.tempoValue);
    setMetronome(settings.metronome);
    setCountInBars(settings.countInBars);
    setHands(settings.hands);
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
    modeRef.current = next;
    setMode(next);
    if (engineRef.current) engineRef.current.settings.mode = next;
  }

  /** A look knob a pinch turned: the next frame reads the same object the lane holds. */
  function changeLook(key: keyof typeof LANE_KNOBS, value: number | boolean): void {
    showLook(key, value);
    setSetting(key, value as never).catch(console.error);
  }

  /** The lane's look as the panel just wrote it, on the lane the next frame draws. */
  function showLook(key: keyof typeof LANE_KNOBS, value: number | boolean): void {
    Object.assign(laneRef.current?.look ?? {}, { [LANE_KNOBS[key]]: value });
  }

  /** A global knob the dialog writes reaches the running play through the same live objects. */
  function applyGlobal(...[key, value]: SettingChange): void {
    const engineField = ENGINE_KNOBS[key as keyof typeof ENGINE_KNOBS];
    if (engineField && engineRef.current) {
      Object.assign(engineRef.current.settings, { [engineField]: value });
      // The keyboard size is the one engine knob the lane lays itself out from.
      if (key.startsWith('keyboard_')) laneRef.current?.setRange();
    }
    if (key in LANE_KNOBS) showLook(key as keyof typeof LANE_KNOBS, value as number | boolean);
    if (key === 'sheet_harmony') sheetRef.current?.setLook({ harmony: value });
    if (key === 'sheet_colour') sheetRef.current?.setLook({ colour: value });
    if (key === 'click_volume') setClickVolume(value);
    if (key === 'sheet_split') setSplit(value);
    if (key === 'sheet_proportional') sheetRef.current?.setProportional(value);
    if (key === 'sheet_spacing') sheetRef.current?.setSpacing(value);
  }

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
    lane.frame(snapshot, engine.windowTicks, wall);
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
      if (event.key === ' ') {
        event.preventDefault();
        toggle();
      } else if (event.key === 'Escape') {
        // Escape clears the Section only in a practice that is already still; every other play,
        // an armed performance included, it aborts.
        const engine = engineRef.current;
        if (engine?.kind === 'practice' && engine.snapshot().state === 'idle') setSection(null);
        else engine?.abort();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Play and pause are the same key and the same disc, whatever the play is doing. */
  function toggle(): void {
    const engine = engineRef.current;
    if (!engine) return;
    const { state: at } = engine.snapshot();
    // Pausing a count-in drops the play back to Idle, so the same key stops it as stops the clock.
    if (at === 'running' || at === 'counting-in') engine.pause();
    else if (at === 'paused') engine.resume();
    // Marks and colours of the last run stay on the sheet until the engine opens the notes again.
    else engine.start();
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
  const stepTempo = (by: number) =>
    changeTempo(clamp(tempo + by, tempoMin, tempoMax));

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
        <div className="border-edge-soft relative flex h-12 flex-none items-center gap-0.5 border-b px-2">
          <BarButton label="Back to library" onClick={onBack}>
            <ArrowLeft {...ICON} />
          </BarButton>
          <b className="ml-1.5 mr-1 min-w-0 truncate text-[13px] font-medium">{title}</b>
          <Mixer
            open={mixerOpen}
            onOpenChange={setMixerOpen}
            onSoundSettings={() => {
              setSettingsJump('instrument_id');
              setSettingsOpen(true);
            }}
            onGlobalChange={applyGlobal}
          />
          <BarButton label="Settings" onClick={() => setSettingsOpen(true)}>
            <SlidersHorizontal {...ICON} />
          </BarButton>

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
                onClick={() => setLoop((on) => !on)}
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
                  <BarButton label="Slower" onClick={() => stepTempo(-TEMPO_STEP)}>
                    <Minus {...ICON} />
                  </BarButton>
                  <TempoPopover
                    mode={tempoMode}
                    value={tempo}
                    constantTempo={written.constant}
                    onMode={switchMode}
                    onValue={changeTempo}
                  />
                  <BarButton label="Faster" onClick={() => stepTempo(TEMPO_STEP)}>
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
            {/* The only worded control: outlined to arm a performance, filled to stop one. */}
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

        <SpacingPopup pinch={pinch} />

        <SettingsPanel
          open={settingsOpen}
          jumpTo={settingsJump}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsJump(null);
          }}
          onGlobalChange={applyGlobal}
          onOpenMixer={() => setMixerOpen(true)}
          live={live}
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
      onPointerUp={() => setSetting('sheet_split', value).catch(console.error)}
    >
      <i className="bg-edge-soft absolute inset-x-0 top-1 block h-px" />
      <i className="bg-edge group-hover:bg-muted-ink absolute top-[2px] left-1/2 block h-[5px] w-9 -translate-x-1/2 rounded-full transition-colors duration-150" />
    </div>
  );
}

/**
 * The tempo readout and its popover: the mode switch and the slider of the active mode. The
 * readout shows the value the clock runs at, `100 %` or `♩ = 96`.
 */
function TempoPopover({
  mode,
  value,
  constantTempo,
  onMode,
  onValue,
}: {
  mode: TempoMode;
  value: number;
  /** BPM mode is offered only for a piece written at one tempo; a flat BPM would flatten the rest. */
  constantTempo: boolean;
  onMode: (mode: TempoMode) => void;
  onValue: (value: number) => void;
}) {
  const [min, max] = TEMPO_RANGE[mode];
  const label = tempoLabel(mode, value);
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              aria-label="Tempo"
              className="hover:bg-ink/8 relative flex h-8 flex-none items-center justify-center rounded-md px-1.5 transition-colors duration-150"
            >
              <span className="text-[13px] font-medium tabular-nums">{label}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Tempo</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="center" className="flex w-56 flex-col gap-3 p-3">
        <div className="border-edge flex self-start border">
          {(['percent', 'bpm'] as const).map((each) => (
            <button
              key={each}
              aria-label={each === 'bpm' ? 'BPM' : 'Percent'}
              aria-pressed={mode === each}
              disabled={each === 'bpm' && !constantTempo}
              onClick={() => onMode(each)}
              className={`h-6 px-3 text-[12px] font-medium transition-colors duration-150 disabled:text-ink/35 ${
                mode === each ? 'bg-ink text-paper' : 'hover:bg-ink/8'
              }`}
            >
              {each === 'bpm' ? 'BPM' : '%'}
            </button>
          ))}
        </div>
        <input
          type="range"
          aria-label={mode === 'bpm' ? 'Tempo in BPM' : 'Tempo in percent'}
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(event) => onValue(Number(event.target.value))}
          className="accent-ink w-full"
        />
        <div className="text-muted-ink flex justify-between text-[11px] tabular-nums">
          <span>{min}</span>
          <span>{max}</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One 32 px shape for every control of the bar. An action is plain ink; a control that is only
 * placed here is `off`, dimmed and inert; a toggle says whether it is on with an under-bar, and one
 * `segment` of a pair says it by filling instead.
 */
function BarButton({
  label,
  onClick,
  off,
  pressed,
  disc,
  wide,
  segment,
  children,
}: {
  label: string;
  onClick?: () => void;
  off?: boolean;
  pressed?: boolean;
  disc?: boolean;
  wide?: boolean;
  segment?: boolean;
  children: React.ReactNode;
}) {
  // A segment sits square inside the pair's shared border and fills when it is the active side;
  // every other toggle is dimmed while off and full ink with an under-bar while on. A control only
  // placed here is `off`: dimmed and inert.
  const filled = segment && pressed;
  const dim = off || (!segment && pressed === false);
  const paint = filled
    ? 'bg-ink text-paper'
    : `${dim ? 'text-ink/35' : ''} ${off ? '' : 'hover:bg-ink/8'}`;
  const shape = disc
    ? 'size-[34px] rounded-full bg-ink text-paper mx-1 hover:bg-ink/85'
    : `h-8 ${segment ? 'rounded-none' : 'rounded-md'} ${wide ? 'px-1.5' : 'w-8'} ${paint}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          aria-disabled={off || undefined}
          aria-pressed={pressed}
          onClick={off ? undefined : onClick}
          className={`relative flex flex-none items-center justify-center transition-colors duration-150 ${shape}`}
        >
          {children}
          {pressed && !segment && <i className="bg-current absolute right-2 bottom-0.5 left-2 h-0.5" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
