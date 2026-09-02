// The Preview: a piece's whole sheet as paper, read-only for input and grading, with a transport
// that plays it through the sound engine. Everything about the piece is the Preview's; this screen
// says where it draws, hands it the keys and the frames, and draws its snapshot with the chrome.

import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { baseNameOf } from '@/library/index-file';
import { reasonOf, setNotice } from '@/library/notice';
import { Opening } from '@/look/loading';
import { useDark } from '@/look/use-dark';
import { stepTempo, TEMPO_KEYS } from '@/play/settings';
import { arrowBack } from '@/play/step';
import { useFrameLoop } from '@/play/use-frame-loop';
import { NO_PREVIEW, Preview } from '@/preview/preview';
import { usePreview } from '@/preview/use-preview';
import { ScoreError } from '@/score/types';
import { BarButton, ICON, TEMPO_STEP, TempoPopover } from '@/screens/bar';
import { SettingsPanel, SpacingPopup } from '@/screens/settings';
import { StatusBar } from '@/screens/status-bar';
import { useFullscreen } from '@/screens/use-fullscreen';
import { commands } from '@/bindings';
import { ArrowLeft, Minus, Pause, Play, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** A window drag fires the observer far faster than a whole sheet can be drawn again. */
const REFIT_MS = 120;

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
  /** The Preview the frames and the keys reach, whatever React has last drawn. */
  const previewRef = useRef<Preview | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const shown = usePreview(preview);
  const dark = useDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const backRef = useRef(onBack);
  backRef.current = onBack;
  const full = useFullscreen();

  /** True from the start of the open until the page stands on the screen, and on a failure too. */
  const [opening, setOpening] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsJump, setSettingsJump] = useState<string | null>(null);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [midiOpen, setMidiOpen] = useState(false);

  const title = shown.title || baseNameOf(path);
  const { playing, tempoMode, tempo, written, pinch, reason } = shown;
  /** The transport is dead until the piece is open and the sound engine has said it can play. */
  const off = !preview || reason !== '';

  // Opening a piece: everything about it is the Preview's, so the screen only says where it draws.
  // Any failure goes back to the library, which says what went wrong.
  useEffect(() => {
    let live = true;
    const fileName = baseNameOf(path);
    setOpening(true);
    void (async () => {
      try {
        const opened = await Preview.open({
          folder,
          path,
          dark: darkRef.current,
          host: hostRef.current!,
        });
        // A piece the screen has already left behind opened for nothing, and leaves as it stands.
        if (!live) return opened.dispose();
        previewRef.current = opened;
        setPreview(opened);
        setOpening(false);
      } catch (error) {
        // A Preview the user closed mid-load throws on the host the cleanup already released, so
        // only a failure while the screen still stands is worth a notice.
        if (!live) return;
        const reason = error instanceof ScoreError ? error.reason : reasonOf(error);
        const row = await commands.pieceGet(path).catch(() => null);
        if (!live) return;
        setNotice(`Could not open ${row?.title ?? fileName}: ${reason}`);
        setOpening(false);
        backRef.current();
      }
    })();
    return () => {
      live = false;
      previewRef.current?.dispose();
      previewRef.current = null;
      setPreview(null);
    };
  }, [folder, path]);

  useEffect(() => {
    preview?.setDark(dark);
  }, [dark, preview]);

  useFrameLoop((_delta, now) => previewRef.current?.frame(now));

  useEffect(() => {
    let timer = 0;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(() => previewRef.current?.fit(), REFIT_MS);
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
      const preview = previewRef.current;
      const { playing, tempo, tempoMode, reason } = preview?.snapshot() ?? NO_PREVIEW;
      const tempoStep = TEMPO_KEYS[event.code];
      if (event.key === ' ') {
        event.preventDefault();
        void preview?.toggle();
      } else if (event.key === 'Escape') {
        // Escape off the start of the piece is a rewind; from the start it leaves.
        if (preview && (playing || preview.seconds() > 0)) preview.rewind();
        else backRef.current();
      } else if (!preview || reason !== '') {
        return;
      } else if (tempoStep) {
        preview.setTempo(stepTempo(tempo, tempoStep, event.shiftKey, tempoMode));
      } else if (event.key.startsWith('Arrow')) {
        // There is no lane here, so the pointer stands over the paper or away from it.
        const back = arrowBack(event.key, hostRef.current?.matches(':hover') ? 'sheet' : null);
        if (back === null) return;
        event.preventDefault();
        preview.step(back, event.shiftKey);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
          <b className="pointer-events-none mr-1 ml-1.5 min-w-0 truncate text-[13px] font-medium">{title}</b>

          {/* The play disc keeps the window's midline whatever the two sides hold, and a dimmed
              button swallows its own tooltip, so the reason for the silence hangs on the wrapper. */}
          <div className="absolute left-1/2 -translate-x-1/2" title={reason || undefined}>
            <BarButton
              label={playing ? 'Pause' : 'Play'}
              disc
              off={off}
              onClick={() => void preview?.toggle()}
            >
              {playing ? <Pause {...ICON} /> : <Play {...ICON} />}
            </BarButton>
          </div>

          <div className="ml-auto flex items-center gap-2.5">
            <div className="flex items-center" title={reason || undefined}>
              <BarButton label="Slower" off={off} onClick={() => preview?.nudgeTempo(-TEMPO_STEP)}>
                <Minus {...ICON} />
              </BarButton>
              <TempoPopover
                mode={tempoMode}
                value={tempo}
                constantTempo={written.constant}
                onMode={(mode) => preview?.switchMode(mode)}
                onValue={(value) => preview?.setTempo(value)}
              />
              <BarButton label="Faster" off={off} onClick={() => preview?.nudgeTempo(TEMPO_STEP)}>
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
