// The Preview: a piece's whole sheet as paper, read-only for input and grading, with a transport
// that plays it through the sound engine. The notes are scheduled in Rust; this screen only builds
// the note list, sends the transport commands and walks the band down the page at its clock.

import { previewNotes, secondsOf, tickAt } from '@/audio/preview';
import type { AudioStatus } from '@/audio/sound-tab';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { readSettings, setSetting } from '@/db/db';
import { baseNameOf, pathOf, readScoreFile } from '@/library/index-file';
import { setNotice } from '@/library/notice';
import { getPiece, updatePieceSettings } from '@/library/queries';
import { reindexIfChanged } from '@/library/scan';
import { clamp } from '@/lib/utils';
import { Opening } from '@/look/loading';
import { useDark } from '@/look/use-dark';
import type { SeekTarget } from '@/play/engine';
import { UNSET_PIECE_SETTINGS, resolvePlaySettings } from '@/play/resolve';
import { DEFAULT_PLAY_SETTINGS, TEMPO_RANGE, type TempoMode } from '@/play/settings';
import { useFrameLoop } from '@/play/use-frame-loop';
import { barTickOf } from '@/score/beat';
import { ScoreError, bpmAt, stepSeconds, type Score } from '@/score/types';
import { BarButton, ICON, TEMPO_STEP, TempoPopover } from '@/screens/bar';
import { SettingsPanel, SpacingPopup, type SettingChange } from '@/screens/settings';
import { StatusBar } from '@/screens/status-bar';
import type { Pinch } from '@/sheet/pinch';
import { PreviewSheet, windowTicksOf } from '@/sheet/preview-sheet';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ArrowLeft, Minus, Pause, Play, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** A window drag fires the observer far faster than a whole sheet can be drawn again. */
const REFIT_MS = 120;

/** The played tick a seek target names, on the first pass through its bar. */
function tickOfTarget(score: Score, target: SeekTarget): number {
  if ('tick' in target) return target.tick;
  for (const step of score.playOrder) {
    const onset = score.onsets[step.onsetIndex]!;
    if ('onset' in target) {
      if (step.onsetIndex === target.onset) return step.tick;
      continue;
    }
    if (onset.measureIndex !== target.measure) continue;
    return barTickOf(step, onset, score.measures[target.measure]!) + (target.into ?? 0);
  }
  return 0;
}

export function PreviewScreen({
  folder,
  path,
  onBack,
  onPlay,
}: {
  folder: string;
  path: string;
  onBack: () => void;
  onPlay: (intent: 'practice' | 'performance') => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<PreviewSheet | null>(null);
  const dark = useDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const backRef = useRef(onBack);
  backRef.current = onBack;

  const [title, setTitle] = useState(baseNameOf(path));
  /** True from the start of the open until the page stands on the screen, and on a failure too. */
  const [opening, setOpening] = useState(true);
  const [playing, setPlaying] = useState(false);
  /** Why there is no sound, empty when there is; null until the engine has answered. */
  const [reason, setReason] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsJump, setSettingsJump] = useState<string | null>(null);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [midiOpen, setMidiOpen] = useState(false);
  /** What a pinch on the page is choosing while it lasts, which the panel over the paper shows. */
  const [pinch, setPinch] = useState<Pinch | null>(null);

  // The tempo is the piece's own, kept as the play screen keeps it: a percent of the written marks
  // or a flat quarter BPM, with the score's own tempo behind the conversion between the two.
  const [tempoMode, setTempoMode] = useState<TempoMode>(DEFAULT_PLAY_SETTINGS.tempoMode);
  const [tempo, setTempo] = useState(DEFAULT_PLAY_SETTINGS.tempoValue);
  const [written, setWritten] = useState({ bpm: 120, constant: false });

  // The note list is the engine's business and never redraws anything, so it stays out of state.
  const notesRef = useRef<ReturnType<typeof previewNotes>>([]);
  /** The second each step of the play order opens at, which the engine's seconds are read against. */
  const startsRef = useRef<number[]>([]);
  /** Whether Rust holds this piece's note list, which is what makes resume a resume. */
  const loadedRef = useRef(false);
  /** The sheet keeps one click handler from the open; this is how it reaches the newest one. */
  const seekRef = useRef((_target: SeekTarget) => {});
  /** The engine's last report, when it landed and the rate it was running at. */
  const clockRef = useRef({ seconds: 0, at: performance.now(), playing: false, rate: 1 });

  const off = reason !== '';
  /** Rust runs at a percent, so BPM mode is that BPM against the tempo the piece is written at. */
  const percent = tempoMode === 'bpm' ? Math.round((100 * tempo) / written.bpm) : tempo;

  /** Where the clock stands now: the last report, carried on at its rate for the time since. */
  const secondsNow = (now = performance.now()): number => {
    const clock = clockRef.current;
    return clock.seconds + (clock.playing ? ((now - clock.at) / 1000) * clock.rate : 0);
  };

  /** Restarts the extrapolation from where the clock stands, which a new rate makes it do. */
  const restartClock = (seconds = secondsNow(), playing = clockRef.current.playing): void => {
    clockRef.current = { seconds, at: performance.now(), playing, rate: percent / 100 };
  };

  /** Hands the engine the piece, once per Preview. */
  const load = async (): Promise<void> => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    await invoke('preview_load', { notes: notesRef.current });
    await invoke('preview_rate', { percent });
  };

  const toggle = async (): Promise<void> => {
    if (off) return;
    if (playing) {
      setPlaying(false);
      restartClock(secondsNow(), false);
      await invoke('preview_pause');
      return;
    }
    setPlaying(true);
    restartClock(secondsNow(), true);
    await load();
    await invoke('preview_play');
  };

  /** Back to the start, with the note list gone from Rust: the next play loads it again. */
  const rewind = (): void => {
    setPlaying(false);
    restartClock(0, false);
    loadedRef.current = false;
    void invoke('preview_stop');
  };

  const seek = async (target: SeekTarget): Promise<void> => {
    const sheet = sheetRef.current;
    if (off || !sheet) return;
    const seconds = secondsOf(sheet.score, startsRef.current, tickOfTarget(sheet.score, target));
    // The local clock moves first, so the band stands on the click this frame rather than waiting
    // for the engine to report back.
    restartClock(seconds);
    await load();
    await invoke('preview_seek', { seconds });
  };
  seekRef.current = (target) => void seek(target);

  const [tempoMin, tempoMax] = TEMPO_RANGE[tempoMode];
  const stepTempo = (by: number): void => changeTempo(clamp(tempo + by, tempoMin, tempoMax));

  /** Every tempo change goes to the piece row, so the piece reopens at the tempo it was left at. */
  function changeTempo(value: number): void {
    setTempo(value);
    updatePieceSettings(path, { tempo_value: value }).catch(console.error);
  }

  /** The two modes read the same piece at the same speed, so a switch carries the value over. */
  function switchMode(next: TempoMode): void {
    if (next === tempoMode) return;
    const [min, max] = TEMPO_RANGE[next];
    const written100 = next === 'bpm' ? (written.bpm * tempo) / 100 : (tempo / written.bpm) * 100;
    const value = clamp(Math.round(written100), min, max);
    setTempoMode(next);
    setTempo(value);
    updatePieceSettings(path, { tempo_mode: next, tempo_value: value }).catch(console.error);
  }

  /** A global knob the panel or the mixer writes reaches the page already on screen. */
  function applyGlobal(...[key, value]: SettingChange): void {
    const sheet = sheetRef.current;
    if (key === 'sheet_proportional') sheet?.setProportional(value);
    if (key === 'sheet_spacing') sheet?.setSpacing(value);
    if (key === 'sheet_harmony') sheet?.setLook({ harmony: value });
    if (key === 'sheet_colour') sheet?.setLook({ colour: value });
  }

  useEffect(() => {
    invoke<AudioStatus>('audio_status')
      .then((status) => setReason(status.available ? '' : status.reason))
      .catch((error: unknown) => setReason(String(error)));
  }, []);

  // A new rate widens or narrows the band and makes the engine's last report stale, so the
  // extrapolation starts again from where the clock has reached.
  useEffect(() => {
    const sheet = sheetRef.current;
    if (sheet) sheet.windowTicks = windowTicksOf(sheet.score, percent);
    restartClock();
    if (loadedRef.current) void invoke('preview_rate', { percent });
  }, [percent]);

  // Where the playback stands, about thirty times a second. The end of the piece arrives as one
  // more report with the time back at zero and nothing playing.
  useEffect(() => {
    const listening = listen<{ seconds: number; playing: boolean }>(
      'preview-progress',
      ({ payload }) => {
        clockRef.current = { ...clockRef.current, ...payload, at: performance.now() };
        if (payload.playing) return;
        if (payload.seconds === 0) sheetRef.current?.finish();
        setPlaying(false);
      },
    );
    return () => void listening.then((stop) => stop());
  }, []);

  // One frame: the clock read on from the last report, and the band on the tick it names.
  useFrameLoop((_delta, now) => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    const seconds = secondsNow(now);
    sheet.frame(tickAt(sheet.score, startsRef.current, seconds), clockRef.current.playing, now);
  });

  // Leaving the screen silences the engine at once, whatever it was doing.
  useEffect(
    () => () => {
      loadedRef.current = false;
      void invoke('preview_stop');
    },
    [],
  );

  // Opening a piece: bring its index up to date in case the file changed, read the bytes and draw
  // them with the Look settings and the piece's own tempo. Any failure goes back to the library,
  // which says what went wrong.
  useEffect(() => {
    let live = true;
    const fileName = baseNameOf(path);
    setOpening(true);
    void (async () => {
      try {
        await reindexIfChanged(folder, path);
        const bytes = await readScoreFile(pathOf(folder, path));
        const [globals, row] = await Promise.all([readSettings(), getPiece(path).catch(() => null)]);
        const sheet = await PreviewSheet.open(
          hostRef.current!,
          bytes,
          fileName,
          darkRef.current,
          globals.sheet_proportional,
          globals.sheet_spacing,
        );
        if (!live) return sheet.dispose();
        sheetRef.current = sheet;
        sheet.onSeek = (target) => seekRef.current(target);
        // A pinch has already spaced the page; this only stores what it settled on.
        sheet.onLook = ({ spacing }) => {
          setSetting('sheet_spacing', spacing).catch(console.error);
        };
        sheet.onPinch = (moving) => setPinch(moving);
        sheet.setLook({ harmony: globals.sheet_harmony, colour: globals.sheet_colour });
        notesRef.current = previewNotes(sheet.score);
        startsRef.current = stepSeconds(sheet.score);
        const resolved = resolvePlaySettings(row ?? UNSET_PIECE_SETTINGS);
        setWritten({
          bpm: sheet.score.hasTempo ? Math.round(bpmAt(sheet.score, 0)) : 120,
          constant: sheet.score.constantTempo,
        });
        setTempoMode(resolved.tempoMode);
        setTempo(resolved.tempoValue);
        setTitle(sheet.score.title || fileName);
        setOpening(false);
      } catch (error) {
        // A Preview the user closed mid-load throws on the host the cleanup already released, so
        // only a failure while the screen still stands is worth a notice.
        if (!live) return;
        const reason = error instanceof ScoreError ? error.reason : String(error);
        const row = await getPiece(path).catch(() => null);
        if (!live) return;
        setNotice(`Could not open ${row?.title ?? fileName}: ${reason}`);
        setOpening(false);
        backRef.current();
      }
    })();
    return () => {
      live = false;
      sheetRef.current?.dispose();
      sheetRef.current = null;
    };
  }, [folder, path]);

  useEffect(() => {
    sheetRef.current?.setDark(dark);
  }, [dark]);

  useEffect(() => {
    let timer = 0;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => sheetRef.current?.fit(), REFIT_MS);
    });
    observer.observe(hostRef.current!);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      // The settings panel and every popover are `role="dialog"`: while one is open the keys are
      // its own and never reach the transport.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (event.key === ' ') {
        event.preventDefault();
        void toggle();
      } else if (event.key === 'Escape') {
        // Escape off the start of the piece is a rewind; from the start it leaves.
        if (playing || secondsNow() > 0) rewind();
        else backRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, off, percent]);

  return (
    <TooltipProvider>
      <div className="bg-chrome fixed inset-0 flex flex-col">
        <div className="border-edge-soft relative flex h-12 flex-none items-center gap-0.5 border-b pr-2 pl-20" data-tauri-drag-region>
          <BarButton label="Back to library" onClick={onBack}>
            <ArrowLeft {...ICON} />
          </BarButton>
          <b className="pointer-events-none mr-1 ml-1.5 min-w-0 truncate text-[13px] font-medium">{title}</b>

          {/* The play disc keeps the window's midline whatever the two sides hold, and a dimmed
              button swallows its own tooltip, so the reason for the silence hangs on the wrapper. */}
          <div className="absolute left-1/2 -translate-x-1/2" title={reason || undefined}>
            <BarButton
              label={playing ? 'Pause' : 'Play'}
              disc
              off={off}
              onClick={() => void toggle()}
            >
              {playing ? <Pause {...ICON} /> : <Play {...ICON} />}
            </BarButton>
          </div>

          <div className="ml-auto flex items-center gap-2.5">
            <div className="flex items-center" title={reason || undefined}>
              <BarButton label="Slower" off={off} onClick={() => stepTempo(-TEMPO_STEP)}>
                <Minus {...ICON} />
              </BarButton>
              <TempoPopover
                mode={tempoMode}
                value={tempo}
                constantTempo={written.constant}
                onMode={switchMode}
                onValue={changeTempo}
              />
              <BarButton label="Faster" off={off} onClick={() => stepTempo(TEMPO_STEP)}>
                <Plus {...ICON} />
              </BarButton>
            </div>
            <Button variant="outline" size="sm" onClick={() => onPlay('practice')}>
              Practice
            </Button>
            <Button size="sm" onClick={() => onPlay('performance')}>
              Perform
            </Button>
          </div>
        </div>

        {/* The systems flow down and the paper never scrolls sideways: it is fitted to the width. */}
        <div className="bg-paper flex-1 overflow-x-hidden overflow-y-auto">
          <div ref={hostRef} />
        </div>

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
          onGlobalChange={applyGlobal}
        />

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
          onOpenMidi={() => setMidiOpen(true)}
        />
      </div>
    </TooltipProvider>
  );
}
