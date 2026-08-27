// The score finder: one search box over every provider, and one download per visit into the
// library folder. Rust holds the indexes, searches them and fetches the bytes; this file formats
// the rows, moves the selection and hands the downloaded file to the ordinary import path.

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { getSetting } from '@/db/db';
import { importFiles } from '@/library/import';
import { invoke } from '@tauri-apps/api/core';
import { Download, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** One search hit, as `finder_search` returns it. */
export interface FinderRow {
  provider: 'KernScores' | 'PDMX';
  /** Composer heading, shared by both providers after normalisation. */
  heading: string;
  title: string;
  opus: string | null;
  number: string | null;
  movement: number | null;
  movementName: string | null;
  key: string | null;
  time: string | null;
  bars: number | null;
  ratings: number;
  /** The uploader's own title when it differs from the site's title field. */
  alt: string | null;
  file: string;
  fileName: string;
}

interface SearchResult {
  rows: FinderRow[];
  /** Matches beyond the rows returned. */
  more: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[.,\s]/g, '');

/** Line one: the title, its opus and number when the title does not already name them, then the movement. */
export function titleLine(r: FinderRow): string {
  const has = (s: string) => norm(r.title).includes(norm(s));
  // A PDMX subtitle of punctuation alone is index noise, not a movement name.
  const sub = r.movementName && /[\p{L}\p{N}]/u.test(r.movementName) ? r.movementName : null;
  let t = r.title;
  if (r.opus && !has(r.opus) && !has(`op ${r.opus}`)) {
    t += `, ${/^\d/.test(r.opus) ? 'Op. ' : ''}${r.opus}`;
    if (r.number) t += ` No. ${r.number}`;
  } else if (r.number && !has(`no ${r.number}`)) {
    t += ` No. ${r.number}`;
  }
  if (r.movement) t += ` · ${r.movement}.${sub ? ` ${sub}` : ''}`;
  else if (sub) t += ` · ${sub}`;
  return t;
}

/** Line two, grey: key, time and bars for KernScores; the uploader's title, bars and ratings for PDMX. */
export function metaLine(r: FinderRow): string {
  return [
    r.alt,
    r.key,
    r.time,
    r.bars ? `${r.bars} bars` : null,
    r.ratings ? `${r.ratings} ratings` : null,
    r.provider,
  ]
    .filter(Boolean)
    .join(' · ');
}

type DownloadState =
  | { state: 'idle' }
  | { state: 'downloading' }
  | { state: 'failed'; provider: string; reason: string };

/** Tauri rejects with a plain string, the import path throws an Error; the bar prints one reason. */
export function reasonOf(error: unknown): string {
  return String(error).replace(/^Error:\s*/, '');
}

/**
 * The finder modal. `libraryPaths` are the lower-cased folder-relative paths of every piece, which
 * a download compares its own root-level name against by the rule the import clash check uses. A
 * row already there says "In library" and never downloads, so the Replace prompt cannot fire here.
 */
export function Finder({
  folder,
  libraryPaths,
  onImported,
  close,
}: {
  folder: string;
  libraryPaths: Set<string>;
  /** The library re-lists and selects the new piece; a failure there belongs in the red bar. */
  onImported: (relPath: string) => Promise<void>;
  close: () => void;
}) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<SearchResult>({ rows: [], more: 0 });
  const [sel, setSel] = useState(0);
  const [dl, setDl] = useState<DownloadState>({ state: 'idle' });
  const [pdmxFolder, setPdmxFolder] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  // A setting the database will not give up leaves the folder empty, which a PDMX download reports.
  useEffect(() => {
    void getSetting('pdmx_folder').then(setPdmxFolder, () => {});
  }, []);

  // Every keystroke searches; Rust answers in under 20 ms. A late answer to an older query is dropped.
  useEffect(() => {
    if (query.trim() === '') {
      setResult({ rows: [], more: 0 });
      return;
    }
    let live = true;
    void invoke<SearchResult>('finder_search', { query }).then(
      (r) => {
        if (!live) return;
        setResult(r);
        setSearchError(null);
      },
      (error: unknown) => {
        if (!live) return;
        setResult({ rows: [], more: 0 });
        setSearchError(`Could not search: ${reasonOf(error)}`);
      },
    );
    return () => {
      live = false;
    };
  }, [query]);

  const rows = result.rows;
  const selected = rows[Math.min(sel, rows.length - 1)] ?? null;
  const owned = (r: FinderRow) => libraryPaths.has(r.fileName.toLowerCase());

  useEffect(() => {
    list.current?.querySelector('[data-selected]')?.scrollIntoView({ block: 'nearest' });
  }, [sel, rows]);

  async function download(): Promise<void> {
    if (!selected || dl.state === 'downloading' || owned(selected)) return;
    const row = selected;
    setDl({ state: 'downloading' });
    let tempPath: string | null = null;
    try {
      const got = await invoke<{ fileName: string; tempPath: string }>('finder_download', {
        row,
        pdmxFolder,
      });
      tempPath = got.tempPath;
      // The name is free: an owned row never gets here. Keep both covers a file the index missed.
      const { imported, failures } = await importFiles(folder, [tempPath], async () => 'keep-both');
      if (failures.length || !imported[0]) throw new Error(failures[0]?.reason ?? 'Import failed');
      await onImported(imported[0]);
    } catch (error) {
      setDl({ state: 'failed', provider: row.provider, reason: reasonOf(error) });
    } finally {
      if (tempPath) await invoke('remove_temp_file', { path: tempPath }).catch(() => {});
    }
  }

  function onKeyDown(event: React.KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSel((s) => Math.min(s + 1, rows.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void download();
    }
  }

  return (
    <Dialog open onOpenChange={close}>
      <DialogContent
        showCloseButton={false}
        onKeyDown={onKeyDown}
        className="top-[12%] flex max-h-[70vh] w-[640px] translate-y-0 flex-col gap-0 p-0 sm:max-w-[640px]"
      >
        <DialogTitle className="sr-only">Find online</DialogTitle>

        <div className="border-edge-soft flex flex-none items-center gap-2.5 border-b px-4">
          <Search className="text-muted-ink size-4" />
          <input
            autoFocus
            value={query}
            placeholder="Composer or title"
            aria-label="Composer or title"
            onChange={(event) => {
              setQuery(event.target.value);
              setSel(0);
              setDl({ state: 'idle' });
            }}
            className="placeholder:text-muted-ink flex-1 bg-transparent py-3 text-[15px] outline-none"
          />
        </div>

        <div ref={list} className="min-h-0 flex-1 overflow-y-auto py-1">
          {query.trim() === '' && <Hint>Type a composer or a title.</Hint>}
          {query.trim() !== '' && rows.length === 0 && (
            <Hint>{searchError ?? `Nothing matches “${query}”.`}</Hint>
          )}
          {rows.map((row, i) => (
            <div key={`${row.provider}${row.file}`}>
              {row.heading !== rows[i - 1]?.heading && (
                <h4 className="text-muted-ink px-4 pt-3 pb-1 text-[12px] font-semibold">
                  {row.heading}
                </h4>
              )}
              <div
                data-selected={row === selected || undefined}
                onMouseMove={() => sel !== i && setSel(i)}
                onClick={() => setSel(i)}
                onDoubleClick={() => void download()}
                className={`flex items-center gap-3 px-4 py-1.5 ${
                  row === selected ? 'bg-[color-mix(in_srgb,var(--ink)_9%,transparent)]' : ''
                }`}
              >
                <span className="flex min-w-0 flex-col gap-px">
                  <b className="truncate text-[13px] font-medium">{titleLine(row)}</b>
                  <span className="text-muted-ink truncate text-[12px]">{metaLine(row)}</span>
                </span>
                <span className="ml-auto flex-none">
                  {owned(row) ? (
                    <span className="text-muted-ink text-[12px]">In library</span>
                  ) : (
                    row === selected && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={dl.state === 'downloading'}
                        onClick={() => void download()}
                      >
                        <Download />
                        {dl.state === 'downloading' ? 'Downloading…' : 'Download'}
                      </Button>
                    )
                  )}
                </span>
              </div>
            </div>
          ))}
          {result.more > 0 && <Hint>{result.more} more. Type more to narrow.</Hint>}
        </div>

        {dl.state === 'failed' && (
          <div
            role="alert"
            className="flex flex-none items-center gap-3 border-t border-red-500/40 bg-red-500/10 px-4 py-2 text-[12px] text-red-600 dark:text-red-400"
          >
            <span>
              Could not download from {dl.provider}: {dl.reason}.
            </span>
            <button onClick={() => void download()} className="underline underline-offset-2">
              Retry
            </button>
          </div>
        )}

        <footer className="border-edge-soft text-muted-ink flex flex-none justify-end gap-3 border-t px-4 py-2 text-[12px]">
          <span>↑↓ select</span>
          <span>↩ download</span>
          <span>esc close</span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-muted-ink px-4 py-3 text-[12px]">{children}</p>;
}
