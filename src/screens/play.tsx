// The play screen: one 48 px bar of controls over the sheet, with the lane under it. Nothing of
// the play lives here: one Play owns it, this draws its snapshot and hands it the frames.

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { SPLIT_MAX, SPLIT_MIN, TOP_BAR } from '@/lane/lane';
import { baseNameOf } from '@/library/index-file';
import { reasonOf, setNotice } from '@/library/notice';
import { clamp } from '@/lib/utils';
import { Collapse } from '@/look/collapse';
import { Opening } from '@/look/loading';
import { Metronome, type MetronomeHandle } from '@/look/metronome';
import { useDark } from '@/look/use-dark';
import { useMidiStatus } from '@/midi/use-midi-status';
import type { PerformanceRecord, PlayKind } from '@/play/engine';
import { Play as PlayOne } from '@/play/play';
import { sectionLabel } from '@/play/section';
import {
  convertTempo,
  type HandsSetting,
  stepTempo,
  TEMPO_KEYS,
  TEMPO_RANGE,
  tempoLabel,
  type TempoMode,
} from '@/play/settings';
import { arrowBack } from '@/play/step';
import { useFrameLoop } from '@/play/use-frame-loop';
import { usePlay } from '@/play/use-play';
import { ScoreError } from '@/score/types';
import { set, setting, useSetting } from '@/settings/settings';
import { Button } from '@/components/ui/button';
import { BarButton, ICON, KeyPopover, TEMPO_STEP, TempoPopover } from '@/screens/bar';
import { SettingsPanel, SpacingPopup } from '@/screens/settings';
import { StatusBar } from '@/screens/status-bar';
import { useFullscreen } from '@/screens/use-fullscreen';
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
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const metronomeRef = useRef<MetronomeHandle>(null);
  /** The play the frames and the keys reach, whatever React has last drawn. */
  const playRef = useRef<PlayOne | null>(null);
  const [play, setPlay] = useState<PlayOne | null>(null);
  const shown = usePlay(play);
  const dark = useDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const full = useFullscreen();

  /** True from the start of the open until the piece stands on the screen, and on a failure too. */
  const [opening, setOpening] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsJump, setSettingsJump] = useState<string | null>(null);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [midiOpen, setMidiOpen] = useState(false);
  /** The split is dragged live and only written when the pointer comes up. */
  const stored = useSetting('sheet_split');
  const [split, setSplit] = useState(() => clamp(setting('sheet_split'), SPLIT_MIN, SPLIT_MAX));
  useEffect(() => setSplit(clamp(stored, SPLIT_MIN, SPLIT_MAX)), [stored]);

  const midi = useMidiStatus((event) => playRef.current?.strike(event));
  const { settings, written } = shown;
  const performing = shown.kind === 'performance';
  const running = shown.state === 'running' || shown.state === 'counting-in';
  const [tempoMin, tempoMax] = TEMPO_RANGE[settings.tempoMode];

  // Opening a piece: everything about it is the Play's, so the screen only says where it draws and
  // what it was opened for. Any failure goes back to the library.
  useEffect(() => {
    setOpening(true);
    let live = true;
    const fileName = baseNameOf(path);
    void (async () => {
      try {
        const opened = await PlayOne.open({
          folder,
          path,
          intent,
          dark: darkRef.current,
          host: hostRef.current!,
          canvas: canvasRef.current!,
        });
        // A piece the screen has already left behind opened for nothing, and leaves as it stands.
        if (!live) return void opened.leave();
        opened.showBeat = (strong, beatMs) => metronomeRef.current?.tick(strong, beatMs);
        playRef.current = opened;
        setPlay(opened);
        setOpening(false);
      } catch (error) {
        // The play screen has no error state: the library says what went wrong instead, and only
        // a failure while this run of the screen still stands is worth a notice.
        if (!live) return;
        const reason = error instanceof ScoreError ? error.reason : reasonOf(error);
        setNotice(`Could not open ${fileName}: ${reason}`);
        setOpening(false);
        backRef.current();
      }
    })();
    return () => {
      live = false;
      void playRef.current?.leave();
      playRef.current = null;
      setPlay(null);
    };
  }, [folder, path, intent]);

  // Quitting is an abort like Back is, and the window waits for this handler, so the practice
  // under way reaches the database before it goes.
  useEffect(() => {
    const listening = getCurrentWindow().onCloseRequested(async () => {
      await playRef.current?.leave();
    });
    return () => void listening.then((stop) => stop(), console.error);
  }, [path]);

  useEffect(() => {
    play?.setDark(dark);
  }, [dark, play]);

  useEffect(() => {
    play?.setDevices(midi.devices.length);
  }, [midi.devices, play]);

  useFrameLoop((delta, now) => playRef.current?.frame(delta, now));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const play = playRef.current;
      if (!play) return;
      const target = event.target;
      if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      // The settings dialog and every popover are `role="dialog"`: while one is open the keys are
      // its own and never reach the clock.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      const tempoStep = TEMPO_KEYS[event.code];
      const { kind, state, settings: at } = play.snapshot();
      if (event.key === ' ') {
        event.preventDefault();
        play.toggle();
      } else if (tempoStep) {
        // Only a practice takes a tempo key; a performance keeps the tempo it was armed at.
        if (kind !== 'practice') return;
        const value = stepTempo(at.tempoValue, tempoStep, event.shiftKey, at.tempoMode);
        play.set({ tempoValue: value });
      } else if (event.key.startsWith('Arrow')) {
        // Only a practice moves by the arrows; a performance is one clean run.
        if (kind !== 'practice') return;
        // The pointer says which arrows act: over the falling notes, over the sheet, or elsewhere.
        const area = canvasRef.current?.matches(':hover')
          ? 'lane'
          : hostRef.current?.matches(':hover')
            ? 'sheet'
            : null;
        const back = arrowBack(event.key, area);
        if (back === null) return;
        event.preventDefault();
        play.step(back, event.shiftKey);
      } else if (event.key === 'Escape') {
        // Escape clears the Section only in a practice that is already still; every other play,
        // an armed performance included, it aborts.
        if (kind === 'practice' && state === 'idle') play.setSection(null);
        else play.abort();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const changeTempo = (value: number) => play?.set({ tempoValue: value });
  const nudgeTempo = (by: number) =>
    changeTempo(clamp(settings.tempoValue + by, tempoMin, tempoMax));

  /** The two modes read the same piece at the same speed, so a switch carries the value over. */
  function switchMode(next: TempoMode): void {
    if (next === settings.tempoMode) return;
    const value = convertTempo(settings.tempoValue, settings.tempoMode, next, written.bpm);
    play?.set({ tempoMode: next, tempoValue: value });
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
          <b className="pointer-events-none ml-1.5 mr-1 min-w-0 truncate text-[13px] font-medium">
            {shown.title || baseNameOf(path)}
          </b>
          <KeyPopover at={shown.key} />

          {/* The play disc keeps the window's midline whatever the two sides hold. */}
          <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-0.5">
            <BarButton
              label="Count-in"
              pressed={settings.countInBars > 0}
              onClick={() => play?.set({ countInBars: settings.countInBars > 0 ? 0 : 1 })}
            >
              <Tally4 {...ICON} />
            </BarButton>
            <Collapse axis="x" open={!performing}>
              <BarButton label="Restart" onClick={() => play?.restart()}>
                <RotateCcw {...ICON} />
              </BarButton>
            </Collapse>
            <BarButton label={running ? 'Pause' : 'Play'} disc onClick={() => play?.toggle()}>
              {running ? <Pause {...ICON} /> : <Play {...ICON} />}
            </BarButton>
            <Collapse axis="x" open={!performing}>
              <BarButton
                label={sectionLabel(shown.measures, shown.section)}
                pressed={settings.loop}
                onClick={() => play?.set({ loop: !settings.loop })}
              >
                <Repeat {...ICON} />
              </BarButton>
            </Collapse>
            <BarButton
              label="Metronome"
              pressed={settings.metronome}
              onClick={() => play?.set({ metronome: !settings.metronome })}
            >
              <Metronome {...ICON} ref={metronomeRef} on={settings.metronome} />
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
                    mode={settings.tempoMode}
                    value={settings.tempoValue}
                    constantTempo={written.constant}
                    onMode={switchMode}
                    onValue={changeTempo}
                  />
                  <BarButton label="Faster" onClick={() => nudgeTempo(TEMPO_STEP)}>
                    <Plus {...ICON} />
                  </BarButton>
                </div>
                {/* The left glyph is the left hand; the hand the play does not expect is dimmed. */}
                <BarButton
                  label={`Hands: ${settings.hands}`}
                  off={shown.oneStaff}
                  onClick={() => play?.set({ hands: NEXT_HANDS[settings.hands] })}
                  wide
                >
                  <Hand {...ICON} className={handGlyph(settings.hands, 'left')} />
                  <Hand {...ICON} className={`scale-x-[-1] ${handGlyph(settings.hands, 'right')}`} />
                </BarButton>
                <div className="border-ink/55 divide-ink/55 flex items-center divide-x overflow-hidden rounded-md border">
                  <BarButton
                    label="Flow mode"
                    segment
                    pressed={settings.mode === 'flow'}
                    onClick={() => play?.set({ mode: 'flow' })}
                  >
                    <FastForward {...ICON} />
                  </BarButton>
                  <BarButton
                    label="Wait mode"
                    segment
                    pressed={settings.mode === 'wait'}
                    onClick={() => play?.set({ mode: 'wait' })}
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
                  onClick={() => (performing ? play?.abort() : play?.arm())}
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
          {shown.state === 'ended' && shown.summary && (
            <Summary
              record={shown.summary.record}
              best={shown.summary.best}
              onAgain={() => play?.toggle()}
              onClose={() => play?.arm()}
            />
          )}
        </div>

        {/* After the sheet and the lane, so the row stands over both of them. */}
        <Opening on={opening} name={shown.title || baseNameOf(path)} />

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

        <SpacingPopup pinch={shown.pinch} />

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
