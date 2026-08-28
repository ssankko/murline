// The Preview: a piece's whole sheet as paper, read-only for input and grading, with a transport
// that plays it through the sound engine. The notes are scheduled in Rust; this screen only builds
// the note list, sends the transport commands and moves the band to the time the engine reports.

import type { AudioStatus } from '@/audio/sound-tab';
import { previewNotes, secondsOf, tickAt } from '@/audio/preview';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { clamp } from '@/lib/utils';
import { baseNameOf, pathOf, readScoreFile } from '@/library/index-file';
import { setNotice } from '@/library/notice';
import { getPiece } from '@/library/queries';
import { reindexIfChanged } from '@/library/scan';
import { useDark } from '@/look/use-dark';
import { MidiLight } from '@/midi/midi-light';
import type { SeekTarget } from '@/play/engine';
import { TEMPO_RANGE } from '@/play/settings';
import { barTickOf } from '@/score/beat';
import { ScoreError, stepSeconds, type Score } from '@/score/types';
import { Mixer } from '@/audio/mixer';
import { SettingsPanel } from '@/screens/settings';
import { PreviewSheet } from '@/sheet/preview-sheet';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ArrowLeft, Minus, Pause, Play, Plus, SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** A window drag fires the observer far faster than a whole sheet can be drawn again. */
const REFIT_MS = 120;

/** What one press of the slower or faster button moves the tempo by. */
const TEMPO_STEP = 5;

const ICON = { size: 16, strokeWidth: 1.75 } as const;

/** The three transport buttons look alike and dim together when there is no engine. */
const TRANSPORT =
  'hover:bg-ink/8 flex size-8 items-center justify-center transition-colors duration-150 disabled:opacity-40';

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
  const [playing, setPlaying] = useState(false);
  const [percent, setPercent] = useState(100);
  /** Why there is no sound, empty when there is; null until the engine has answered. */
  const [reason, setReason] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsJump, setSettingsJump] = useState<string | null>(null);
  const [mixerOpen, setMixerOpen] = useState(false);

  // The note list is the engine's business and never redraws anything, so it stays out of state.
  const notesRef = useRef<ReturnType<typeof previewNotes>>([]);
  /** The second each step of the play order opens at, which the engine's seconds are read against. */
  const startsRef = useRef<number[]>([]);
  /** Whether Rust holds this piece's note list, which is what makes resume a resume. */
  const loadedRef = useRef(false);
  /** The sheet keeps one click handler from the open; this is how it reaches the newest one. */
  const seekRef = useRef((_target: SeekTarget) => {});

  const off = reason !== '';

  /** Hands the engine the piece, once per Preview. */
  const load = async (): Promise<void> => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    await invoke('preview_load', { notes: notesRef.current });
    await invoke('preview_rate', { percent });
  };

  const toggle = async (): Promise<void> => {
    if (playing) {
      setPlaying(false);
      await invoke('preview_pause');
      return;
    }
    setPlaying(true);
    await load();
    await invoke('preview_play');
  };

  const seek = async (target: SeekTarget): Promise<void> => {
    const sheet = sheetRef.current;
    if (off || !sheet) return;
    const tick = tickOfTarget(sheet.score, target);
    sheet.frame(tick, playing, performance.now());
    await load();
    await invoke('preview_seek', { seconds: secondsOf(sheet.score, startsRef.current, tick) });
  };
  seekRef.current = (target) => void seek(target);

  const stepTempo = (by: number): void => {
    const next = clamp(percent + by, ...TEMPO_RANGE.percent);
    setPercent(next);
    void invoke('preview_rate', { percent: next });
  };

  useEffect(() => {
    invoke<AudioStatus>('audio_status')
      .then((status) => setReason(status.available ? '' : status.reason))
      .catch((error: unknown) => setReason(String(error)));
  }, []);

  // Where the playback stands, about thirty times a second. The end of the piece arrives as one
  // more event with the time back at zero and nothing playing.
  useEffect(() => {
    const listening = listen<{ seconds: number; playing: boolean }>(
      'preview-progress',
      ({ payload }) => {
        const sheet = sheetRef.current;
        if (sheet) {
          const tick = tickAt(sheet.score, startsRef.current, payload.seconds);
          sheet.frame(tick, payload.playing, performance.now());
        }
        if (!payload.playing) setPlaying(false);
      },
    );
    return () => void listening.then((stop) => stop());
  }, []);

  // Leaving the screen silences the engine at once, whatever it was doing.
  useEffect(
    () => () => {
      loadedRef.current = false;
      void invoke('preview_stop');
    },
    [],
  );

  // Opening a piece: bring its index up to date in case the file changed, read the bytes and draw
  // them. Any failure goes back to the library, which says what went wrong.
  useEffect(() => {
    let live = true;
    const fileName = baseNameOf(path);
    void (async () => {
      try {
        await reindexIfChanged(folder, path);
        const bytes = await readScoreFile(pathOf(folder, path));
        const sheet = await PreviewSheet.open(hostRef.current!, bytes, fileName, darkRef.current);
        if (!live) return sheet.dispose();
        sheetRef.current = sheet;
        sheet.onSeek = (target) => seekRef.current(target);
        notesRef.current = previewNotes(sheet.score);
        startsRef.current = stepSeconds(sheet.score);
        setTitle(sheet.score.title || fileName);
      } catch (error) {
        // A Preview the user closed mid-load throws on the host the cleanup already released, so
        // only a failure while the screen still stands is worth a notice.
        if (!live) return;
        const reason = error instanceof ScoreError ? error.reason : String(error);
        const row = await getPiece(path).catch(() => null);
        if (!live) return;
        setNotice(`Could not open ${row?.title ?? fileName}: ${reason}`);
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
      // The settings panel and every popover are `role="dialog"`: while one is open Escape is its
      // own and never reaches the transport.
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (event.key === 'Escape') backRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="bg-chrome fixed inset-0 flex flex-col">
      <TooltipProvider>
        <div className="border-edge-soft flex h-12 flex-none items-center gap-2 border-b px-2">
          <button
            aria-label="Back to library"
            onClick={onBack}
            className="hover:bg-ink/8 flex size-8 flex-none items-center justify-center transition-colors duration-150"
          >
            <ArrowLeft size={18} strokeWidth={1.75} />
          </button>
          <b className="min-w-0 truncate text-[13px] font-medium">{title}</b>
          {/* A disabled button swallows its own tooltip, so the reason hangs on the wrapper. */}
          <div className="ml-auto flex flex-none items-center gap-1" title={reason || undefined}>
            <button
              aria-label={playing ? 'Pause' : 'Play'}
              disabled={off}
              onClick={() => void toggle()}
              className={TRANSPORT}
            >
              {playing ? <Pause {...ICON} /> : <Play {...ICON} />}
            </button>
            <button
              aria-label="Slower"
              disabled={off}
              onClick={() => stepTempo(-TEMPO_STEP)}
              className={TRANSPORT}
            >
              <Minus {...ICON} />
            </button>
            <span className="w-11 text-center text-[12px] tabular-nums">{percent} %</span>
            <button
              aria-label="Faster"
              disabled={off}
              onClick={() => stepTempo(TEMPO_STEP)}
              className={TRANSPORT}
            >
              <Plus {...ICON} />
            </button>
          </div>
          <div className="flex flex-none items-center gap-2 pl-2">
            <Button variant="outline" size="sm" onClick={() => onPlay('practice')}>
              Practice
            </Button>
            <Button size="sm" onClick={() => onPlay('performance')}>
              Perform
            </Button>
            <MidiLight
              onOpenSettings={() => {
                setSettingsJump('midi_device');
                setSettingsOpen(true);
              }}
            />
            <Mixer
              open={mixerOpen}
              onOpenChange={setMixerOpen}
              onSoundSettings={() => {
                setSettingsJump('instrument_id');
                setSettingsOpen(true);
              }}
            />
            <button
              aria-label="Settings"
              onClick={() => setSettingsOpen(true)}
              className="hover:bg-ink/8 flex size-8 flex-none items-center justify-center transition-colors duration-150"
            >
              <SlidersHorizontal {...ICON} />
            </button>
          </div>
        </div>
      </TooltipProvider>

      <SettingsPanel
        open={settingsOpen}
        jumpTo={settingsJump}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsJump(null);
        }}
        onOpenMixer={() => setMixerOpen(true)}
      />

      {/* The systems flow down and the paper never scrolls sideways: it is fitted to the width. */}
      <div className="bg-paper flex-1 overflow-x-hidden overflow-y-auto">
        <div ref={hostRef} />
      </div>
    </div>
  );
}
