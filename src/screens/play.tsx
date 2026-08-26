// The play screen: one 48 px bar of controls over the sheet, with the lane under it. One clock,
// one frame loop, no state of the play in React beyond what the bar has to draw.

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { getSettingOr, setSetting } from '@/db/db';
import {
  DEFAULT_LANE_LOOK,
  DEFAULT_SPLIT,
  Lane,
  SPLIT_MAX,
  SPLIT_MIN,
  type LaneLook,
} from '@/lane/lane';
import { setNotice } from '@/library/notice';
import { reindexIfChanged } from '@/library/scan';
import { flipTheme, useDark } from '@/look/use-dark';
import { useMidiStatus } from '@/midi/useMidiStatus';
import { create, type Engine, type PlayState } from '@/play/engine';
import { DEFAULT_PLAY_SETTINGS } from '@/play/settings';
import { useFrameLoop } from '@/play/use-frame-loop';
import { ScoreError, type Note } from '@/score/types';
import { Sheet } from '@/sheet/sheet';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowLeft,
  FastForward,
  Hand,
  Metronome,
  Minus,
  Pause,
  Play,
  Plus,
  Repeat,
  RotateCcw,
  Settings,
  Tally4,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** One size and one stroke for every icon in the bar. */
const ICON = { size: 18, strokeWidth: 1.75 } as const;

/** Height of the top bar, the strip the split does not divide. */
const TOP_BAR = 48;

const TEMPO_STEP = 5;
const TEMPO_MIN = 25;
const TEMPO_MAX = 200;

/** What the screen was opened for. A performance is armed at bar one; ticket 11 arms it. */
export type PlayIntent = 'practice' | 'performance';

export function PlayScreen({
  folder,
  path,
  onBack,
}: {
  folder: string;
  path: string;
  intent?: PlayIntent;
  onBack: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sheetRef = useRef<Sheet | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const laneRef = useRef<Lane | null>(null);
  /** Notes wearing a red miss mark, so the next start of motion can take them all off. */
  const missedRef = useRef<Note[]>([]);
  const dark = useDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const backRef = useRef(onBack);
  backRef.current = onBack;

  const [title, setTitle] = useState(path.split('/').pop() ?? path);
  const [state, setState] = useState<PlayState>('idle');
  const stateRef = useRef<PlayState>('idle');
  const [tempo, setTempo] = useState(DEFAULT_PLAY_SETTINGS.tempoValue);
  const tempoRef = useRef(tempo);
  tempoRef.current = tempo;
  const [split, setSplit] = useState(DEFAULT_SPLIT);

  const midi = useMidiStatus((event) => engineRef.current?.strike(event));
  const midiRef = useRef(midi);
  midiRef.current = midi;

  // Opening a piece: bring its index up to date in case the file changed, read the bytes, render
  // the sheet and build the Score of what was rendered. Any failure goes back to the library.
  useEffect(() => {
    let live = true;
    const fileName = path.split('/').pop() ?? path;
    void (async () => {
      try {
        await reindexIfChanged(folder, path);
        const bytes = new Uint8Array(
          await invoke<ArrayBuffer>('read_file', { path: `${folder}/${path}` }),
        );
        const look = await laneLook();
        const sheet = await Sheet.open(hostRef.current!, bytes, fileName, darkRef.current);
        if (!live) return sheet.dispose();
        sheetRef.current = sheet;
        const engine = create(sheet.score, {
          ...DEFAULT_PLAY_SETTINGS,
          tempoValue: tempoRef.current,
        });
        engineRef.current = engine;
        laneRef.current = new Lane(canvasRef.current!, engine, look.lane, darkRef.current);
        setSplit(look.split);
        setTitle(sheet.score.title || fileName);
      } catch (error) {
        // The play screen has no error state: the library says what went wrong instead.
        const reason = error instanceof ScoreError ? error.reason : String(error);
        setNotice(`Could not open ${fileName}: ${reason}`);
        if (live) backRef.current();
      }
    })();
    return () => {
      live = false;
      engineRef.current?.abort();
      sheetRef.current?.dispose();
      sheetRef.current = null;
      engineRef.current = null;
      laneRef.current = null;
    };
  }, [folder, path]);

  useEffect(() => {
    sheetRef.current?.setDark(dark);
    laneRef.current?.setDark(dark);
  }, [dark]);

  // An unplugged cable must not run the cursor away from a player who cannot answer it.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || midi.devices.length > 0) return;
    if (engine.kind === 'practice' && engine.snapshot().state === 'running') engine.pause();
  }, [midi.devices]);

  useEffect(() => {
    const engine = engineRef.current;
    if (engine) engine.settings.tempoValue = tempo;
  }, [tempo]);

  useFrameLoop((delta, now) => {
    const engine = engineRef.current;
    const sheet = sheetRef.current;
    const lane = laneRef.current;
    if (!engine || !sheet || !lane) return;
    // Strikes carry the plugin's Unix timestamp, so the clock takes wall time on the same timeline.
    engine.advance(delta, performance.timeOrigin + now);
    const snapshot = engine.snapshot();
    for (const event of engine.events()) {
      lane.effect(event, now);
      if (event.verdict === 'miss') {
        const note = engine.notes[event.noteIndex]!.note;
        missedRef.current.push(note);
        sheet.markNote(note, 'miss');
      }
    }
    sheet.frame(snapshot, engine.windowTicks, now);
    lane.notice = midiRef.current.devices.length === 0 ? 'no MIDI device' : null;
    lane.frame(snapshot, engine.windowTicks, now);
    if (snapshot.state !== stateRef.current) {
      stateRef.current = snapshot.state;
      setState(snapshot.state);
    }
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      if (event.key === ' ') {
        event.preventDefault();
        toggle();
      } else if (event.key === 'Escape') {
        engineRef.current?.abort();
      } else if (event.key === 'd') {
        flipTheme();
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
    if (at === 'running') engine.pause();
    else if (at === 'paused') engine.resume();
    else {
      // Marks and colours of the last run stay on the sheet until motion starts again.
      for (const note of missedRef.current) sheetRef.current?.markNote(note, 'none');
      missedRef.current.length = 0;
      engine.start();
    }
  }

  const running = state === 'running' || state === 'counting-in';
  const stepTempo = (by: number) =>
    setTempo((value) => Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, value + by)));

  return (
    <TooltipProvider>
      <div className="bg-chrome fixed inset-0 flex flex-col">
        <div className="border-edge-soft relative flex h-12 flex-none items-center gap-0.5 border-b px-2">
          <BarButton label="Back to library" onClick={onBack}>
            <ArrowLeft {...ICON} />
          </BarButton>
          <b className="ml-1.5 mr-1 min-w-0 truncate text-[13px] font-medium">{title}</b>
          <BarButton label="Piece settings" off>
            <Settings {...ICON} />
          </BarButton>

          {/* The play disc keeps the window's midline whatever the two sides hold. */}
          <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5">
            <BarButton label="Count-in" off pressed={false}>
              <Tally4 {...ICON} />
            </BarButton>
            <BarButton label="Restart" onClick={() => engineRef.current?.restart()}>
              <RotateCcw {...ICON} />
            </BarButton>
            <BarButton label={running ? 'Pause' : 'Play'} disc onClick={toggle}>
              {running ? <Pause {...ICON} /> : <Play {...ICON} />}
            </BarButton>
            <BarButton label="Loop" off pressed={false}>
              <Repeat {...ICON} />
            </BarButton>
            <BarButton label="Metronome" off pressed={false}>
              <Metronome {...ICON} />
            </BarButton>
          </div>

          <div className="ml-auto flex items-center gap-2.5">
            <div className="flex items-center">
              <BarButton label="Slower" onClick={() => stepTempo(-TEMPO_STEP)}>
                <Minus {...ICON} />
              </BarButton>
              <BarButton label="Tempo" off wide>
                <span className="text-[13px] font-medium tabular-nums">{tempo} %</span>
              </BarButton>
              <BarButton label="Faster" onClick={() => stepTempo(TEMPO_STEP)}>
                <Plus {...ICON} />
              </BarButton>
            </div>
            <BarButton label="Hands: both" off wide>
              <Hand {...ICON} />
              <Hand {...ICON} className="scale-x-[-1]" />
            </BarButton>
            <div className="flex items-center">
              <BarButton label="Flow mode" off pressed={true}>
                <FastForward {...ICON} />
              </BarButton>
              <BarButton label="Wait mode" off pressed={false}>
                <Hand {...ICON} />
              </BarButton>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label="Perform"
                  aria-disabled
                  className="border-ink/55 text-ink/35 flex h-[30px] items-center border px-3.5 text-[13px] font-medium"
                >
                  Perform
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Perform</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div ref={hostRef} className="bg-paper min-h-0" style={{ flex: `${split} 1 0` }} />
        <Split value={split} onChange={setSplit} />
        <div className="bg-paper min-h-0" style={{ flex: `${1 - split} 1 0` }}>
          <canvas ref={canvasRef} className="block h-full w-full" />
        </div>
      </div>
    </TooltipProvider>
  );
}

/** The global settings the lane and the split open with. The gear writes them; ticket 13 draws it. */
async function laneLook(): Promise<{ lane: LaneLook; split: number }> {
  const [lookaheadBeats, noteWidthPct, gapPx, keyLabels, split] = await Promise.all([
    getSettingOr('lane_lookahead', DEFAULT_LANE_LOOK.lookaheadBeats),
    getSettingOr('lane_note_width', DEFAULT_LANE_LOOK.noteWidthPct),
    getSettingOr('lane_gap', DEFAULT_LANE_LOOK.gapPx),
    getSettingOr('keyboard_labels', DEFAULT_LANE_LOOK.keyLabels),
    getSettingOr('sheet_split', DEFAULT_SPLIT),
  ]);
  return {
    lane: { lookaheadBeats, noteWidthPct, gapPx, keyLabels },
    split: Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, split)),
  };
}

/**
 * The hairline between sheet and lane: a 9 px hit area over a 1 px line, with a pill to say it can
 * be dragged. Dragging it shows more or fewer beats and never changes the beat scale.
 */
function Split({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const drag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.buttons === 0) return;
    const share = (event.clientY - TOP_BAR) / Math.max(window.innerHeight - TOP_BAR, 1);
    onChange(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, share)));
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
      onPointerUp={() => void setSetting('sheet_split', value)}
    >
      <i className="bg-edge-soft absolute inset-x-0 top-1 block h-px" />
      <i className="bg-edge group-hover:bg-muted-ink absolute top-[2px] left-1/2 block h-[5px] w-9 -translate-x-1/2 rounded-full transition-colors duration-150" />
    </div>
  );
}

/**
 * One 32 px shape for every control of the bar. An action is plain ink; a control that is only
 * placed here is `off`, dimmed and inert; a toggle also says whether it is on.
 */
function BarButton({
  label,
  onClick,
  off,
  pressed,
  disc,
  wide,
  children,
}: {
  label: string;
  onClick?: () => void;
  off?: boolean;
  pressed?: boolean;
  disc?: boolean;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const shape = disc
    ? 'size-[34px] rounded-full bg-ink text-paper mx-1 hover:bg-ink/85'
    : `h-8 ${wide ? 'px-1.5' : 'w-8'} ${off ? 'text-ink/35' : 'hover:bg-ink/8'}`;
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
          {pressed && <i className="bg-current absolute right-2 bottom-0.5 left-2 h-0.5" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
