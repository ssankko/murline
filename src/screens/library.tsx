import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getSettingOr, setSetting, SETTING_DEFAULTS } from '@/db/db';
import { isMissingFile, pathOf } from '@/library/index-file';
import {
  importFiles,
  SCORE_EXTENSIONS,
  type ClashChoice,
  type ImportFailure,
} from '@/library/import';
import { reasonOf, setNotice, useNotice } from '@/library/notice';
import {
  allPiecePaths,
  deletePiece,
  listPieces,
  matches,
  setFavorite,
  type PieceRow,
  type SortOrder,
} from '@/library/queries';
import { scanLibrary, splitError } from '@/library/scan';
import { clamp } from '@/lib/utils';
import { Collapse } from '@/look/collapse';
import { Finder } from '@/screens/finder';
import { Detail } from '@/screens/piece-detail';
import { SettingsPanel } from '@/screens/settings';
import { StatusBar } from '@/screens/status-bar';
import { useFullscreen } from '@/screens/use-fullscreen';
import { call } from '@/rust';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { ArrowUpDown, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

const SORTS: [SortOrder, string][] = [
  ['recent', 'Recently played'],
  ['title', 'Title'],
  ['composer', 'Composer'],
  ['grade', 'Best grade'],
  ['favorites', 'Favorites'],
];

/** The library page: every piece of the folder on the left, the selected piece's facts on the right. */
export function Library({
  folder,
  selected: opened,
  onFolder,
  onPlay,
  onPreview,
}: {
  folder: string | null;
  /** The piece the play screen came back from: it stands over the stored selection. */
  selected?: string;
  /** A folder chosen here or in the settings dialog: the app re-points and moves no file. */
  onFolder: (folder: string) => void;
  onPlay: (path: string, intent: 'practice' | 'performance') => void;
  onPreview: (path: string) => void;
}) {
  const [pieces, setPieces] = useState<PieceRow[]>([]);
  const [selected, setSelected] = useState<string | null>(opened ?? null);
  const [sort, setSort] = useState<SortOrder>(SETTING_DEFAULTS.library_sort);
  /** What the search field holds. It lives for the session alone and is never stored. */
  const [query, setQuery] = useState('');
  /** Whether the stored sort and selection have arrived; the list waits on them. */
  const [restored, setRestored] = useState(false);
  const [folderGone, setFolderGone] = useState(false);
  const [notice, dismissNotice] = useNotice();
  const [dragging, setDragging] = useState(false);
  const [clash, setClash] = useState<Clash | null>(null);
  /** The lower-cased, NFC folder-relative paths of every present piece, read when the finder opens. */
  const [finding, setFinding] = useState<Set<string> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The row the panel opens on, which only the mixer's way into the Sound tab sets. */
  const [settingsJump, setSettingsJump] = useState<string | null>(null);
  const [mixerOpen, setMixerOpen] = useState(false);
  const [midiOpen, setMidiOpen] = useState(false);
  const full = useFullscreen();

  // The list waits on this, so no row is picked before the stored sort and selection arrive. It
  // runs once: the route's piece stands over the stored one at the mount that carries it.
  useEffect(() => {
    void (async () => {
      const [storedSort, storedSelected] = await Promise.all([
        getSettingOr('library_sort'),
        getSettingOr('library_selected'),
      ]);
      setSort(storedSort);
      if (!opened) setSelected(storedSelected);
      setRestored(true);
    })();
  }, []);

  // Both are kept for the next launch. `selected` holds what the user reached, so the first row
  // standing in for a piece that is gone is never written.
  useEffect(() => {
    if (restored) setSetting('library_sort', sort).catch(console.error);
  }, [restored, sort]);
  useEffect(() => {
    if (restored) setSetting('library_selected', selected).catch(console.error);
  }, [restored, selected]);

  // `scanLibrary` walks a folder once, so a sort change costs the re-list alone.
  useEffect(() => {
    if (!restored) return;
    let live = true;
    void (async () => {
      try {
        if (folder) await scanLibrary(folder);
        if (live) setFolderGone(false);
      } catch {
        if (live) setFolderGone(true);
      }
      try {
        const rows = await listPieces(sort);
        if (live) setPieces(rows);
      } catch (error) {
        if (live) setNotice(`Could not read the library: ${reasonOf(error)}`);
      }
    })();
    return () => {
      live = false;
    };
  }, [folder, sort, restored]);

  /** The listener below outlives the render that registered it, so it drops through this. */
  const importRef = useRef(runImport);
  importRef.current = runImport;

  // Dropped paths come from the window event: WKWebView never hands the DOM a real file path.
  useEffect(() => {
    const listening = getCurrentWebview().onDragDropEvent((event) => {
      setDragging(event.payload.type === 'enter' || event.payload.type === 'over');
      if (event.payload.type === 'drop') void importRef.current(event.payload.paths);
    });
    return () => {
      void listening.then((unlisten) => unlisten());
    };
  }, []);

  // Favorites filters, so a toggle can add or remove a row: re-read rather than patch one.
  async function toggleFavorite(row: PieceRow) {
    await setFavorite(row.path, !row.favorite);
    setPieces(await listPieces(sort));
  }

  const sortLabel = `Sort: ${SORTS.find(([key]) => key === sort)![1]}`;
  /** The rows the search field leaves. The detail pane reads `pieces`, so a hidden row stays picked. */
  const shown = pieces.filter((row) => matches(row, query));
  const piece = pieces.find((p) => p.path === selected) ?? pieces[0];

  /** The text outlives its notice by one collapse, so the bar has words to show as it closes. */
  const lastNotice = useRef('');
  if (notice !== null) lastNotice.current = notice;

  // The selected row can sit anywhere in the list: on a return from a play, on an import, on a
  // delete. `nearest` moves nothing while the row is already in view.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current
      ?.querySelector('[data-selected]')
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [piece?.path]);

  // ⌘F is the webview's own find without this, and that find bar reaches nothing the list draws.
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const dialog = document.querySelector('[role="dialog"][data-state="open"]') !== null;
      if (!findsPieces(event, dialog)) return;
      event.preventDefault();
      search.current?.focus();
      search.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Asks Replace, Keep both or Cancel and waits for the click. */
  function askClash(fileName: string): Promise<ClashChoice> {
    return new Promise((resolve) =>
      setClash({
        fileName,
        decide: (choice) => {
          setClash(null);
          resolve(choice);
        },
      }),
    );
  }

  async function runImport(paths: string[]): Promise<void> {
    if (!folder) return;
    const { imported, failures } = await importFiles(folder, paths, askClash);
    setPieces(await listPieces(sort));
    if (imported.length) setSelected(imported[imported.length - 1]!);
    // Successes are silent, and they leave a notice about something else where it is.
    if (failures.length) setNotice(failureNotice(failures));
  }

  /** "In library" answers for the whole folder, not for the rows the current sort shows. */
  async function openFinder(): Promise<void> {
    const paths = await allPiecePaths();
    setFinding(new Set(paths.map((path) => path.toLowerCase().normalize('NFC'))));
  }

  async function pickFiles(): Promise<void> {
    const picked = await open({
      multiple: true,
      filters: [{ name: 'Sheet music', extensions: SCORE_EXTENSIONS }],
    });
    if (picked) await runImport(picked);
  }

  /** Trash, row, plays, then the row that took its place in the list. */
  async function remove(target: PieceRow): Promise<void> {
    if (!folder) return;
    try {
      await call('trash_file', { path: pathOf(folder, target.path) });
    } catch (error) {
      // A file already gone from disk still drops its piece; any other refusal keeps the row.
      if (!isMissingFile(error)) {
        setNotice(`Could not delete ${target.title ?? target.path}: ${reasonOf(error)}`);
        return;
      }
    }
    await deletePiece(target.path);
    const at = pieces.findIndex((row) => row.path === target.path);
    const rows = await listPieces(sort);
    setPieces(rows);
    setSelected((rows[at] ?? rows[rows.length - 1])?.path ?? null);
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* Fullscreen hides the traffic lights, so the gap kept for them folds away. */}
      <div
        className={`border-edge-soft relative flex h-12 flex-none items-center border-b pr-2 ${full ? 'pl-2' : 'pl-20'} transition-[padding] duration-200 ease-[var(--ease)] motion-reduce:transition-none`}
        data-tauri-drag-region
      >
        <h1 className="pointer-events-none text-[15px] font-semibold">Library</h1>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="border-edge-soft flex w-[340px] flex-none flex-col border-r">
          <div className="border-edge-soft flex h-10 flex-none items-center gap-2 border-b px-3">
            <div className="bg-chrome/60 focus-within:ring-edge flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 focus-within:ring-1">
              <Search className="text-muted-ink size-3.5 flex-none" />
              <input
                ref={search}
                type="search"
                value={query}
                aria-label="Search library"
                placeholder="Search"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') return setQuery('');
                  const step = ARROWS[event.key];
                  if (!step || shown.length === 0) return;
                  // The caret stays where it is: the arrows belong to the list while the field
                  // holds the focus, and the effect above scrolls the row they reach into view.
                  event.preventDefault();
                  const at = shown.findIndex((row) => row === piece);
                  setSelected(shown[nextRow(shown.length, at, step)]!.path);
                }}
                className="placeholder:text-muted-ink min-w-0 flex-1 bg-transparent text-[13px] outline-none"
              />
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  aria-label={sortLabel}
                  title={sortLabel}
                  className="hover:bg-ink/8 flex size-7 flex-none items-center justify-center rounded-md transition-colors duration-150"
                >
                  <ArrowUpDown className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={sort}
                  onValueChange={(value) => setSort(value as SortOrder)}
                >
                  {SORTS.map(([key, label]) => (
                    <DropdownMenuRadioItem key={key} value={key} className="text-[13px]">
                      {label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* No folder at all reads the same as one that has gone: there is nothing to list. */}
          {(!folder || folderGone) && (
            <div className="border-edge-soft flex items-center gap-2 border-b px-4 py-2 text-[12px]">
              <p className="min-w-0">
                Library folder not found
                <span className="text-muted-ink"> {folder}</span>
              </p>
              {/* The folder has one home now: the panel's Library tab. */}
              <Button
                variant="outline"
                size="sm"
                className="ml-auto h-7 flex-none"
                onClick={() => setSettingsOpen(true)}
              >
                Settings…
              </Button>
            </div>
          )}

          <Collapse open={notice !== null}>
            <div className="border-edge-soft flex items-start gap-2 border-y px-4 py-2 text-[12px]">
              <p className="whitespace-pre-line">{lastNotice.current}</p>
              <button
                onClick={dismissNotice}
                aria-label="Dismiss"
                className="text-muted-ink hover:text-ink ml-auto flex-none"
              >
                ✕
              </button>
            </div>
          </Collapse>

          <div ref={list} className="flex-1 overflow-y-auto">
            {shown.map((row) => (
              <Row
                key={row.path}
                row={row}
                selected={row === piece}
                onSelect={() => setSelected(row.path)}
                onOpen={() => !row.error && folder && onPreview(row.path)}
              />
            ))}
            {pieces.length === 0 && (
              <p className="text-muted-ink px-4 py-6 text-center text-[12px]">No pieces yet.</p>
            )}
            {pieces.length > 0 && shown.length === 0 && (
              <p className="text-muted-ink px-4 py-6 text-center text-[12px]">
                Nothing matches “{query.trim()}”.
              </p>
            )}
          </div>

          <div className="border-edge-soft flex gap-2 border-t px-3 py-2.5">
            <Button variant="outline" size="sm" disabled={!folder} onClick={() => void pickFiles()}>
              Import
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!folder}
              onClick={() => void openFinder()}
            >
              Find online
            </Button>
          </div>
        </div>

        {piece ? (
          <Detail
            piece={piece}
            folder={folder}
            onFavorite={() => void toggleFavorite(piece)}
            onDelete={() => void remove(piece)}
            onPlay={onPlay}
            onPreview={onPreview}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center px-12">
            <div className="flex max-w-[420px] flex-col gap-2 text-center">
              <p className="text-[13px]">Copy a MusicXML file into the folder to add a piece.</p>
              <p className="text-muted-ink text-[12px]">{folder ?? 'No library folder set'}</p>
            </div>
          </div>
        )}
      </div>

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

      <div
        aria-hidden={!dragging}
        className={`border-ink/40 bg-paper/80 pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded border-2 border-dashed text-[15px] transition-opacity duration-150 ease-[var(--ease)] motion-reduce:transition-none ${
          dragging ? 'opacity-100' : 'opacity-0'
        }`}
      >
        Drop sheet music to import
      </div>

      {finding && folder && (
        <Finder
          folder={folder}
          libraryPaths={finding}
          onImported={async (relPath) => {
            // The re-list runs first: a failure then throws back into the finder's red bar
            // instead of leaving the modal closed over a library that never changed.
            const rows = await listPieces(sort);
            setFinding(null);
            setPieces(rows);
            setSelected(relPath);
          }}
          close={() => setFinding(null)}
        />
      )}

      {/* A new library folder re-points the app. The scan runs again and no file is touched. */}
      <SettingsPanel
        open={settingsOpen}
        jumpTo={settingsJump}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsJump(null);
        }}
        onGlobalChange={(key, value) => {
          if (key === 'library_folder') onFolder(value as string);
        }}
        onOpenMixer={() => setMixerOpen(true)}
        onOpenMidi={() => setMidiOpen(true)}
      />

      {clash && (
        <Dialog open onOpenChange={() => clash.decide('cancel')}>
          <DialogContent showCloseButton={false} className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle className="text-[15px]">{clash.fileName}</DialogTitle>
              <DialogDescription>
                The library folder already holds a file of this name.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={() => clash.decide('cancel')}>
                Cancel
              </Button>
              <Button variant="outline" size="sm" onClick={() => clash.decide('keep-both')}>
                Keep both
              </Button>
              <Button size="sm" onClick={() => clash.decide('replace')}>
                Replace
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/** The step each arrow key takes through the rows the search field leaves. */
const ARROWS: Record<string, number | undefined> = { ArrowDown: 1, ArrowUp: -1 };

/** The row an arrow key reaches from row `at` of `count` rows: the ends hold, they do not wrap. */
export function nextRow(count: number, at: number, step: number): number {
  return clamp(at + step, 0, count - 1);
}

/**
 * Whether a key press is the shortcut that reaches the search field. A dialog over the screen owns
 * every key while it stands, the field included.
 */
export function findsPieces(event: KeyboardEvent, dialogOpen: boolean): boolean {
  return event.metaKey && event.key === 'f' && !dialogOpen;
}

/** A name already in the folder, waiting on the user's answer. */
interface Clash {
  fileName: string;
  decide: (choice: ClashChoice) => void;
}

/** One line naming the count, then one line per file with its reason. */
function failureNotice(failures: ImportFailure[]): string {
  const head = `${failures.length} file${failures.length === 1 ? '' : 's'} could not be imported`;
  return [head, ...failures.map((f) => `${f.fileName} — ${f.reason}`)].join('\n');
}

/** Two lines and a grade. A piece the app could not read shows its reason in place of the composer. */
function Row({
  row,
  selected,
  onSelect,
  onOpen,
}: {
  row: PieceRow;
  selected: boolean;
  onSelect: () => void;
  /** A double-click reads the piece through: the same Preview the detail's button opens. */
  onOpen: () => void;
}) {
  return (
    <button
      data-selected={selected || undefined}
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={`relative flex w-full items-center gap-3 px-4 py-2 text-left transition-colors duration-[120ms] motion-reduce:transition-none ${
        selected ? 'bg-(--fill-selected)' : 'hover:bg-(--fill-hover)'
      }`}
    >
      <i
        className={`bg-ink absolute top-2 bottom-2 left-0 w-[2px] transition-opacity duration-100 motion-reduce:transition-none ${
          row.favorite ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <span className="flex min-w-0 flex-col gap-px select-text">
        <b className={`truncate text-[13px] font-medium ${row.error ? 'text-muted-ink' : ''}`}>
          {row.title ?? row.path}
        </b>
        <span className="text-muted-ink truncate text-[13px]">
          {row.error ? splitError(row.error).reason : (row.composer ?? ' ')}
        </span>
      </span>
      <span className="ml-auto text-[13px] font-medium tabular-nums">
        {row.best_grade ?? <span className="text-edge">—</span>}
      </span>
    </button>
  );
}
