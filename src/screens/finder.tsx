// The score finder: one search box over every provider, and one download per visit into the
// library folder. Rust holds the indexes, searches them and fetches the bytes; this file formats
// the rows, moves the selection and hands the downloaded file to the ordinary import path.

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { getSetting } from '@/db/db';
import { importFiles } from '@/library/import';
import { reasonOf } from '@/library/notice';
import { Collapse } from '@/look/collapse';
import { Loading } from '@/look/loading';
import { call, type FinderRow, type SearchResult } from '@/rust';
import { Download, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

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

/**
 * The finder modal. `libraryPaths` are the lower-cased, NFC folder-relative paths of every piece,
 * which a download compares its own root-level name against by the rule the import clash check
 * uses. A row already there says "In library" and never downloads, so the Replace prompt cannot
 * fire here.
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
  /** Whether the PDMX folder holds unpacked scores, and so whether a PDMX row can be delivered. */
  const [pdmx, setPdmx] = useState<boolean | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);

  // A setting the database will not give up leaves the folder empty, which a PDMX download reports.
  useEffect(() => {
    void (async () => {
      const held = await getSetting('pdmx_folder').catch(() => null);
      setPdmxFolder(held);
      setPdmx(await call('pdmx_status', { folder: held ?? '' }).catch(() => false));
    })();
  }, []);

  // Every keystroke searches; Rust answers in under 20 ms. A late answer to an older query is
  // dropped. Nothing is asked for until the PDMX status is in, which decides what the answer holds.
  useEffect(() => {
    if (pdmx === null) return;
    if (query.trim() === '') {
      setResult({ rows: [], more: 0 });
      return;
    }
    let live = true;
    void call('finder_search', { query, pdmx }).then(
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
  }, [query, pdmx]);

  const rows = result.rows;
  const selected = rows[Math.min(sel, rows.length - 1)] ?? null;
  // A volume that normalises names on write (HFS+, SMB) answers the scan decomposed, so both
  // sides of the comparison are lowercased and composed. `libraryPaths` arrives that way.
  const owned = (r: FinderRow) => libraryPaths.has(r.fileName.toLowerCase().normalize('NFC'));

  /** The reason outlives its failure by one collapse, so the red bar has words to show as it closes. */
  const lastFailure = useRef({ provider: '', reason: '' });
  if (dl.state === 'failed') lastFailure.current = dl;

  useEffect(() => {
    list.current
      ?.querySelector('[data-selected]')
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [sel, rows]);

  async function download(): Promise<void> {
    if (!selected || dl.state === 'downloading' || owned(selected)) return;
    const row = selected;
    setDl({ state: 'downloading' });
    let tempPath: string | null = null;
    try {
      tempPath = await call('finder_download', { row, pdmxFolder });
      // The name is free: an owned row never gets here. Keep both covers a file the index missed.
      const { imported, failures } = await importFiles(folder, [tempPath], async () => 'keep-both');
      if (failures.length || !imported[0]) throw new Error(failures[0]?.reason ?? 'Import failed');
      await onImported(imported[0]);
    } catch (error) {
      setDl({ state: 'failed', provider: row.provider, reason: reasonOf(error) });
    } finally {
      if (tempPath) await call('remove_temp_file', { path: tempPath }).catch(() => {});
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
              {/* The Download button only renders on the selected row, so every row holds the
                  height it would take (h-8 plus py-1.5) and the selection moves no row. */}
              <div
                data-selected={row === selected || undefined}
                onMouseMove={() => sel !== i && setSel(i)}
                onClick={() => setSel(i)}
                onDoubleClick={() => void download()}
                className={`flex min-h-11 items-center gap-3 px-4 py-1.5 ${
                  row === selected ? 'bg-(--fill-selected)' : ''
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
                        <Loading on={dl.state === 'downloading'} label="Downloading the score" />
                      </Button>
                    )
                  )}
                </span>
              </div>
            </div>
          ))}
          {result.more > 0 && <Hint>{result.more} more. Type more to narrow.</Hint>}
        </div>

        <Collapse open={dl.state === 'failed'}>
          <div
            role="alert"
            className="flex items-center gap-3 border-t border-red-500/40 bg-red-500/10 px-4 py-2 text-[12px] text-red-600 dark:text-red-400"
          >
            <span>
              Could not download from {lastFailure.current.provider}: {lastFailure.current.reason}.
            </span>
            <button onClick={() => void download()} className="underline underline-offset-2">
              Retry
            </button>
          </div>
        </Collapse>

        <footer className="border-edge-soft text-muted-ink flex flex-none justify-end gap-3 border-t px-4 py-2 text-[12px]">
          {pdmx === false && (
            <span className="mr-auto">PDMX not downloaded. Settings › Library.</span>
          )}
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
