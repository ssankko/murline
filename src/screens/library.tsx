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
import { baseNameOf } from '@/library/index-file';
import {
  importFiles,
  SCORE_EXTENSIONS,
  type ClashChoice,
  type ImportFailure,
} from '@/library/import';
import { setNotice, useNotice } from '@/library/notice';
import {
  allPiecePaths,
  deletePiece,
  listPieces,
  recentPlays,
  setFavorite,
  type PieceRow,
  type PlayRow,
  type SortOrder,
} from '@/library/queries';
import { scanLibrary } from '@/library/scan';
import { colorOf, noteName } from '@/look/color';
import { useDark } from '@/look/use-dark';
import { setSetting } from '@/db/db';
import {
  readPieceDefaults,
  resolvePlaySettings,
  type Inherited,
  type PieceSettings,
} from '@/play/resolve';
import { Finder } from '@/screens/finder';
import { SettingsDialog } from '@/screens/settings';
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
export function Library({
  folder,
  selected: opened,
  onFolder,
  onPlay,
  onPreview,
}: {
  folder: string | null;
  /** The piece the play screen came back from, so leaving a play lands on it again. */
  selected?: string;
  /** A folder chosen here or in the settings dialog: the app re-points and moves no file. */
  onFolder: (folder: string) => void;
  onPlay: (path: string, intent: 'practice' | 'performance') => void;
  onPreview: (path: string) => void;
}) {
  const [pieces, setPieces] = useState<PieceRow[]>([]);
  const [selected, setSelected] = useState<string | null>(opened ?? null);
  const [sort, setSort] = useState<SortOrder>('title');
  const [folderGone, setFolderGone] = useState(false);
  const [notice, dismissNotice] = useNotice();
  const [dragging, setDragging] = useState(false);
  const [clash, setClash] = useState<Clash | null>(null);
  /** The lower-cased file names of every present piece, read when the finder opens. */
  const [finding, setFinding] = useState<Set<string> | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [defaults, setDefaults] = useState<Partial<PieceSettings>>({});

  // The Play settings list holds the resolved values, so it needs the middle level of every field.
  useEffect(() => {
    void readPieceDefaults().then(setDefaults);
  }, [settingsOpen]);

  // The scan runs once per folder, so only a re-point walks the folder again. The sort the user
  // chose is read as it stands, which a re-point must not undo.
  useEffect(() => {
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
        if (live) setNotice(`Could not read the library: ${String(error)}`);
      }
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

  // Favorites filters, so a toggle can add or remove a row: re-read rather than patch one.
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
    // Successes are silent, and they leave a notice about something else where it is.
    if (failures.length) setNotice(failureNotice(failures));
  }

  /** A new library folder: the setting moves, the launch scan runs again, no file is touched. */
  async function chooseFolder(): Promise<void> {
    const picked = await open({ directory: true, defaultPath: folder ?? undefined });
    if (typeof picked !== 'string') return;
    await setSetting('library_folder', picked);
    onFolder(picked);
  }

  /** "In library" answers for the whole folder, not for the rows the current sort shows. */
  async function openFinder(): Promise<void> {
    const paths = await allPiecePaths();
    setFinding(new Set(paths.map((path) => baseNameOf(path).toLowerCase())));
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
    try {
      await invoke('trash_file', { path: `${folder}/${target.path}` });
    } catch (error) {
      // A file already gone from disk still drops its piece; any other refusal keeps the row.
      if (!/no such file|not found/i.test(String(error))) {
        setNotice(`Could not delete ${target.title ?? target.path}: ${String(error)}`);
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
          <Button
            variant="ghost"
            size="icon"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Settings />
          </Button>
        </div>

        {/* No folder at all reads the same as one that has gone: there is nothing to list. */}
        {(!folder || folderGone) && (
          <div className="border-edge-soft flex items-center gap-2 border-y px-4 py-2 text-[12px]">
            <p className="min-w-0">
              Library folder not found
              <span className="text-muted-ink"> {folder}</span>
            </p>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7 flex-none"
              onClick={() => void chooseFolder()}
            >
              Choose…
            </Button>
          </div>
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
              onOpen={() => !row.error && folder && onPreview(row.path)}
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
          defaults={defaults}
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

      {dragging && (
        <div className="border-ink/40 bg-paper/80 pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded border-2 border-dashed text-[15px]">
          Drop sheet music to import
        </div>
      )}

      {finding && folder && (
        <Finder
          folder={folder}
          libraryNames={finding}
          onImported={async (relPath) => {
            setFinding(null);
            setPieces(await listPieces(sort));
            setSelected(relPath);
          }}
          close={() => setFinding(null)}
        />
      )}

      {settingsOpen && (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onGlobalChange={(key, value) => {
            if (key === 'library_folder') onFolder(value as string);
          }}
        />
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
      onClick={onSelect}
      onDoubleClick={onOpen}
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
  defaults,
  onFavorite,
  onDelete,
  onPlay,
  onPreview,
}: {
  piece: PieceRow;
  folder: string | null;
  /** The Playing defaults group, the level a piece falls back to. */
  defaults: Partial<PieceSettings>;
  onFavorite: () => void;
  onDelete: () => void;
  onPlay: (path: string, intent: 'practice' | 'performance') => void;
  onPreview: (path: string) => void;
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
            <Button variant="outline" size="sm" disabled={!folder} onClick={onDelete}>
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
          <Button
            variant="outline"
            size="sm"
            disabled={broken || !folder}
            onClick={() => onPreview(piece.path)}
          >
            Preview
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={broken || !folder}
            onClick={() => onPlay(piece.path, 'practice')}
          >
            Practice
          </Button>
          <Button
            size="sm"
            disabled={broken || !folder}
            onClick={() => onPlay(piece.path, 'performance')}
          >
            Perform
          </Button>
        </div>

        <div className="mt-12 grid grid-cols-[3fr_2fr] gap-12">
          <History piece={piece} />
          <PlaySettingsList piece={piece} defaults={defaults} />
        </div>
      </div>
    </div>
  );
}

/**
 * What the piece plays at: its own settings where it holds any, the global default elsewhere. The
 * play screen is the editor; this list only reads.
 */
function PlaySettingsList({
  piece,
  defaults,
}: {
  piece: PieceRow;
  defaults: Partial<PieceSettings>;
}) {
  const { settings, inherited } = resolvePlaySettings(piece, defaults);
  const rows: [string, string, keyof Inherited][] = [
    [
      'Tempo',
      settings.tempoMode === 'bpm' ? `♩ = ${settings.tempoValue}` : `${settings.tempoValue} %`,
      'tempoValue',
    ],
    ['Metronome', settings.metronome ? 'on' : 'off', 'metronome'],
    ['Count-in', countInText(settings.countInBars), 'countInBars'],
    ['Hands', settings.hands, 'hands'],
    ['Keyboard', keyboardText(settings), 'keyboardPreset'],
  ];
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[13px] font-semibold">Play settings</h3>
      <dl className="divide-edge-soft border-edge-soft divide-y border-y">
        {rows.map(([label, value, field]) => (
          <div key={label} className="flex justify-between gap-3 py-1.5 text-[12px]">
            <dt className="text-muted-ink">{label}</dt>
            <dd
              className={inherited[field] ? 'text-muted-ink' : ''}
              title={inherited[field] ? 'Global default' : undefined}
            >
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function countInText(bars: number): string {
  return bars === 0 ? 'off' : `${bars} bar${bars === 1 ? '' : 's'}`;
}

function keyboardText(settings: PieceSettings): string {
  if (settings.keyboardPreset === 'piece') return 'piece range';
  if (settings.keyboardPreset === 'custom') {
    return `${noteName(settings.keyboardLo)}–${noteName(settings.keyboardHi)}`;
  }
  return `${settings.keyboardPreset} keys`;
}

/**
 * What the piece has been played: the summary over the ledger of the last six plays. A practice
 * shows its time, a performance the settings it ran at and its grade.
 */
function History({ piece }: { piece: PieceRow }) {
  const [plays, setPlays] = useState<PlayRow[]>([]);

  useEffect(() => {
    let live = true;
    void recentPlays(piece.path).then((rows) => {
      if (live) setPlays(rows);
    });
    return () => {
      live = false;
    };
  }, [piece.path]);

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[13px] font-semibold">History</h3>
      {plays.length === 0 ? (
        <p className="text-muted-ink text-[12px]">Never played.</p>
      ) : (
        <>
          <p className="text-[12px]">
            <span className="tabular-nums">{duration(piece.practised_s ?? 0)}</span> practised
            <span className="text-muted-ink"> · best </span>
            <span className="tabular-nums">{piece.best_grade ?? '—'}</span>
            <span className="text-muted-ink"> · last played {day(piece.last_played)}</span>
          </p>
          <ul className="divide-edge-soft border-edge-soft divide-y border-y">
            {plays.map((play) => (
              <li
                key={play.id}
                className={`grid grid-cols-[4.5rem_1fr_auto_2.5rem] items-baseline gap-3 py-1.5 text-[12px] ${
                  play.kind === 'practice' ? 'text-muted-ink' : ''
                }`}
              >
                <span>{play.kind === 'practice' ? 'Practice' : 'Performance'}</span>
                <span>{day(play.started_at)}</span>
                <span className="tabular-nums">
                  {play.kind === 'practice' ? duration(play.duration_s) : settingsOf(play)}
                </span>
                <span className="text-right tabular-nums">
                  {play.grade ?? <span className="text-edge">—</span>}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** The tempo and hands a performance ran at, which is what makes two grades comparable. */
function settingsOf(play: PlayRow): string {
  const { tempo_value: value, tempo_mode: mode } = play;
  const tempo = value === null ? '' : mode === 'bpm' ? `♩ = ${value}` : `${value} %`;
  return [tempo, play.hands === 'both' ? '' : play.hands].filter(Boolean).join(' · ');
}

/** Today and yesterday by name, anything older by date. */
function day(at: number | null): string {
  if (at === null) return '—';
  const date = new Date(at).toDateString();
  if (date === new Date().toDateString()) return 'today';
  if (date === new Date(Date.now() - 86_400_000).toDateString()) return 'yesterday';
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
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
  const minutes = Math.floor(seconds / 60);
  const rest = `${minutes % 60}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
  return minutes < 60 ? rest : `${Math.floor(minutes / 60)}:${rest.padStart(5, '0')}`;
}

function reasonOf(error: string): string {
  return error.split(': ')[0] ?? error;
}

function detailOf(error: string): string {
  return error.split(': ').slice(1).join(': ');
}
