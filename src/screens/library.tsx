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
import {
  importFiles,
  SCORE_EXTENSIONS,
  type ClashChoice,
  type ImportFailure,
} from '@/library/import';
import { setNotice, useNotice } from '@/library/notice';
import {
  deletePiece,
  listPieces,
  setFavorite,
  type PieceRow,
  type SortOrder,
} from '@/library/queries';
import { scanLibrary } from '@/library/scan';
import { colorOf, noteName } from '@/look/color';
import { useDark } from '@/look/use-dark';
import { RangeStrip } from '@/screens/range-strip';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { open } from '@tauri-apps/plugin-dialog';
import { Settings } from 'lucide-react';
import { useEffect, useState } from 'react';

const SORTS: [SortOrder, string][] = [
  ['recent', 'Recently played'],
  ['title', 'Title'],
  ['composer', 'Composer'],
  ['grade', 'Best grade'],
  ['favorites', 'Favorites'],
];

/** The library page: every piece of the folder on the left, the selected piece's facts on the right. */
export function Library({ folder }: { folder: string | null }) {
  const [pieces, setPieces] = useState<PieceRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [sort, setSort] = useState<SortOrder>('title');
  const [folderGone, setFolderGone] = useState(false);
  const [notice, dismissNotice] = useNotice();
  const [dragging, setDragging] = useState(false);
  const [clash, setClash] = useState<Clash | null>(null);

  // The scan runs once, at launch. Nothing watches the folder and the page never rescans.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        if (folder) await scanLibrary(folder);
      } catch {
        if (live) setFolderGone(true);
      }
      const rows = await listPieces();
      if (live) setPieces(rows);
    })();
    return () => {
      live = false;
    };
  }, [folder]);

  // Dropped paths come from the window event: WKWebView never hands the DOM a real file path.
  useEffect(() => {
    const listening = getCurrentWebview().onDragDropEvent((event) => {
      setDragging(event.payload.type === 'enter' || event.payload.type === 'over');
      if (event.payload.type === 'drop') void runImport(event.payload.paths);
    });
    return () => {
      void listening.then((unlisten) => unlisten());
    };
  }, [folder]);

  function chooseSort(next: SortOrder) {
    setSort(next);
    void listPieces(next).then(setPieces);
  }

  // Favorites is a sort, so a toggle can add or remove a row: re-read rather than patch one.
  async function toggleFavorite(row: PieceRow) {
    await setFavorite(row.path, !row.favorite);
    setPieces(await listPieces(sort));
  }

  const piece = pieces.find((p) => p.path === selected) ?? pieces[0];

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
    setNotice(failures.length ? failureNotice(failures) : null);
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
    await invoke('trash_file', { path: `${folder}/${target.path}` });
    await deletePiece(target.path);
    const at = pieces.findIndex((row) => row.path === target.path);
    const rows = await listPieces(sort);
    setPieces(rows);
    setSelected((rows[at] ?? rows[rows.length - 1])?.path ?? null);
  }

  return (
    <div className="relative flex h-full">
      <div className="border-edge-soft flex w-[340px] flex-none flex-col border-r">
        <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
          <h1 className="mr-auto text-[15px] font-semibold">Library</h1>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="text-muted-ink text-[12px]">
                {SORTS.find(([key]) => key === sort)![1]}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup
                value={sort}
                onValueChange={(value) => chooseSort(value as SortOrder)}
              >
                {SORTS.map(([key, label]) => (
                  <DropdownMenuRadioItem key={key} value={key} className="text-[13px]">
                    {label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon" aria-label="Settings">
            <Settings />
          </Button>
        </div>

        {folderGone && (
          <p className="border-edge-soft border-y px-4 py-2 text-[12px]">
            Library folder not found
            <span className="text-muted-ink"> {folder}</span>
          </p>
        )}

        {notice && (
          <div className="border-edge-soft flex items-start gap-2 border-y px-4 py-2 text-[12px]">
            <p className="whitespace-pre-line">{notice}</p>
            <button
              onClick={dismissNotice}
              aria-label="Dismiss"
              className="text-muted-ink hover:text-ink ml-auto flex-none"
            >
              ✕
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          {pieces.map((row) => (
            <Row
              key={row.path}
              row={row}
              selected={row === piece}
              onSelect={() => setSelected(row.path)}
            />
          ))}
          {pieces.length === 0 && (
            <p className="text-muted-ink px-4 py-6 text-center text-[12px]">No pieces yet.</p>
          )}
        </div>

        <div className="border-edge-soft flex gap-2 border-t px-3 py-2.5">
          <Button variant="outline" size="sm" disabled={!folder} onClick={() => void pickFiles()}>
            Import
          </Button>
          <Button variant="outline" size="sm" disabled>
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
        />
      ) : (
        <div className="flex flex-1 items-center justify-center px-12">
          <div className="flex max-w-[420px] flex-col gap-2 text-center">
            <p className="text-[13px]">Copy a MusicXML file into the folder to add a piece.</p>
            <p className="text-muted-ink text-[12px]">{folder ?? 'No library folder set'}</p>
          </div>
        </div>
      )}

      {dragging && (
        <div className="border-ink/40 bg-paper/80 pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded border-2 border-dashed text-[15px]">
          Drop sheet music to import
        </div>
      )}

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
}: {
  row: PieceRow;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`relative flex w-full items-center gap-3 px-4 py-2 text-left transition-colors duration-[120ms] motion-reduce:transition-none ${
        selected ? 'bg-[color-mix(in_srgb,var(--ink)_9%,transparent)]' : 'hover:bg-[color-mix(in_srgb,var(--ink)_4%,transparent)]'
      }`}
    >
      <i
        className={`bg-ink absolute top-2 bottom-2 left-0 w-[2px] transition-opacity duration-100 motion-reduce:transition-none ${
          row.favorite ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <span className="flex min-w-0 flex-col gap-px">
        <b className={`truncate text-[13px] font-medium ${row.error ? 'text-muted-ink' : ''}`}>
          {row.title ?? row.path}
        </b>
        <span className="text-muted-ink truncate text-[13px]">
          {row.error ? reasonOf(row.error) : (row.composer ?? ' ')}
        </span>
      </span>
      <span className="ml-auto text-[13px] font-medium tabular-nums">
        {row.best_grade ?? <span className="text-edge">—</span>}
      </span>
    </button>
  );
}

function Detail({
  piece,
  folder,
  onFavorite,
  onDelete,
}: {
  piece: PieceRow;
  folder: string | null;
  onFavorite: () => void;
  onDelete: () => void;
}) {
  const broken = !!piece.error;
  const fullPath = folder ? `${folder}/${piece.path}` : piece.path;
  return (
    <div className="flex-1 overflow-y-auto px-12 py-10">
      <div className="flex max-w-[640px] flex-col">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-[28px] leading-tight font-semibold tracking-tight">
              {piece.title ?? piece.path}
              {piece.composer && (
                <span className="text-muted-ink ml-2.5 text-[15px] font-normal">
                  {piece.composer}
                </span>
              )}
            </h2>
            <div className="text-muted-ink mt-2 flex gap-2.5 text-[12px]">
              {(piece.part_count ?? 1) > 1 && (
                <span>
                  {piece.part_name}, 1 of {piece.part_count} parts
                </span>
              )}
              <code className="text-[11.5px]">{fullPath}</code>
              <button
                onClick={() => void invoke('reveal_in_finder', { path: fullPath })}
                className="hover:text-ink underline underline-offset-2"
              >
                Reveal in Finder
              </button>
            </div>
          </div>
          <div className="flex flex-none gap-1">
            <Button
              variant={piece.favorite ? 'default' : 'outline'}
              size="sm"
              className="duration-100 motion-reduce:transition-none"
              aria-pressed={!!piece.favorite}
              onClick={onFavorite}
            >
              Favorite
            </Button>
            <Button variant="outline" size="sm" onClick={onDelete}>
              Delete
            </Button>
          </div>
        </div>

        {broken ? (
          <div className="mt-7 flex flex-col gap-1.5 text-[13px]">
            <b className="font-semibold">{reasonOf(piece.error!)}</b>
            <details className="text-muted-ink text-[12px]">
              <summary className="cursor-pointer select-none">Details</summary>
              <code className="mt-1 block text-[11.5px] whitespace-pre-wrap">
                {detailOf(piece.error!)}
              </code>
            </details>
          </div>
        ) : (
          <>
            <div className="mt-7">
              <RangeStrip
                lo={piece.midi_lo ?? 21}
                hi={piece.midi_hi ?? 108}
                tonic={tonicOf(piece)}
              />
            </div>
            <Facts piece={piece} />
          </>
        )}

        <div className="mt-8 flex gap-2">
          <Button variant="outline" size="sm" disabled>
            Preview
          </Button>
          <Button variant="outline" size="sm" disabled>
            Practice
          </Button>
          <Button size="sm" disabled>
            Perform
          </Button>
        </div>

        <div className="mt-12 grid grid-cols-[3fr_2fr] gap-12">
          <section className="flex flex-col gap-3">
            <h3 className="text-[13px] font-semibold">History</h3>
            <p className="text-muted-ink text-[12px]">Never played.</p>
          </section>
          <section className="flex flex-col gap-3">
            <h3 className="text-[13px] font-semibold">Play settings</h3>
            <p className="text-muted-ink text-[12px]">Global defaults.</p>
          </section>
        </div>
      </div>
    </div>
  );
}

/** Muted label over value: what the piece is, before it is opened. */
function Facts({ piece }: { piece: PieceRow }) {
  const tonic = tonicOf(piece);
  const facts: [string, React.ReactNode][] = [
    ['Bars', piece.measure_count],
    ['Length', piece.duration_s === null ? null : duration(piece.duration_s)],
    [
      'Range',
      piece.midi_lo === null || piece.midi_hi === null
        ? null
        : `${noteName(piece.midi_lo)}–${noteName(piece.midi_hi)}`,
    ],
    [
      'Key',
      <span key="key" className="flex items-center gap-1.5">
        {tonic !== null && <TonicDot midi={60 + tonic} />}
        {keyName(piece)}
      </span>,
    ],
    ['Tempo', tempoText(piece)],
  ];
  return (
    <dl className="mt-4 flex gap-8">
      {facts.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5">
          <dt className="text-muted-ink text-[12px]">{label}</dt>
          <dd className="text-[15px] font-medium tabular-nums">
            {value ?? <span className="text-edge">—</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function TonicDot({ midi }: { midi: number }) {
  const dark = useDark();
  return (
    <i
      className="inline-block size-[9px] rounded-full"
      style={{ background: colorOf(midi, 'muted', dark) }}
    />
  );
}

const MAJOR_SHARP = ['C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
const MAJOR_FLAT = ['C', 'F', 'B♭', 'E♭', 'A♭', 'D♭', 'G♭', 'C♭'];
const MINOR_SHARP = ['A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D♯', 'A♯'];
const MINOR_FLAT = ['A', 'D', 'G', 'C', 'F', 'B♭', 'E♭', 'A♭'];

function keyName(piece: PieceRow): string | null {
  if (piece.key_sharps === null) return null;
  const minor = piece.key_mode === 'minor';
  const names = minor
    ? piece.key_sharps >= 0
      ? MINOR_SHARP
      : MINOR_FLAT
    : piece.key_sharps >= 0
      ? MAJOR_SHARP
      : MAJOR_FLAT;
  return `${names[Math.abs(piece.key_sharps)]} ${minor ? 'minor' : 'major'}`;
}

/** Pitch class of the key's tonic: seven semitones per sharp, three more down for a minor key. */
function tonicOf(piece: PieceRow): number | null {
  if (piece.key_sharps === null) return null;
  const major = (((piece.key_sharps * 7) % 12) + 12) % 12;
  return piece.key_mode === 'minor' ? (major + 9) % 12 : major;
}

/** The index stores whether the piece has one tempo, not which; the number lives in the Score. */
function tempoText(piece: PieceRow): string | null {
  if (piece.has_tempo === null) return null;
  if (!piece.has_tempo) return 'no tempo mark';
  return piece.constant_tempo ? 'one tempo' : 'varies';
}

function duration(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

function reasonOf(error: string): string {
  return error.split(': ')[0] ?? error;
}

function detailOf(error: string): string {
  return error.split(': ').slice(1).join(': ');
}
