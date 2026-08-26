// The Preview: a piece's whole sheet as paper, read-only. One header of four controls over a
// column of systems that scrolls down. Nothing here clocks, listens to MIDI or writes.

import { Button } from '@/components/ui/button';
import { readScoreFile } from '@/library/index-file';
import { setNotice } from '@/library/notice';
import { reindexIfChanged } from '@/library/scan';
import { useDark } from '@/look/use-dark';
import { ScoreError } from '@/score/types';
import { PreviewSheet } from '@/sheet/preview-sheet';
import { ArrowLeft } from 'lucide-react';
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
  const sheetRef = useRef<PreviewSheet | null>(null);
  const dark = useDark();
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const backRef = useRef(onBack);
  backRef.current = onBack;

  const [title, setTitle] = useState(path.split('/').pop() ?? path);

  // Opening a piece: bring its index up to date in case the file changed, read the bytes and draw
  // them. Any failure goes back to the library, which says what went wrong.
  useEffect(() => {
    let live = true;
    const fileName = path.split('/').pop() ?? path;
    void (async () => {
      try {
        await reindexIfChanged(folder, path);
        const bytes = await readScoreFile(`${folder}/${path}`);
        const sheet = await PreviewSheet.open(hostRef.current!, bytes, fileName, darkRef.current);
        if (!live) return sheet.dispose();
        sheetRef.current = sheet;
        setTitle(sheet.score.title || fileName);
      } catch (error) {
        const reason = error instanceof ScoreError ? error.reason : String(error);
        setNotice(`Could not open ${fileName}: ${reason}`);
        if (live) backRef.current();
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
      if (event.key === 'Escape') backRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="bg-chrome fixed inset-0 flex flex-col">
      <div className="border-edge-soft flex h-12 flex-none items-center gap-2 border-b px-2">
        <button
          aria-label="Back to library"
          onClick={onBack}
          className="hover:bg-ink/8 flex size-8 flex-none items-center justify-center transition-colors duration-150"
        >
          <ArrowLeft size={18} strokeWidth={1.75} />
        </button>
        <b className="min-w-0 truncate text-[13px] font-medium">{title}</b>
        <div className="ml-auto flex flex-none gap-2">
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
    </div>
  );
}
