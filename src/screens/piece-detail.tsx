// The detail pane of the library page: what a piece is and what it has been played. Nothing here
// writes; Favorite and Delete are the list pane's, handed down as callbacks.

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { baseNameOf, pathOf } from '@/library/index-file';
import { reasonOf, setNotice } from '@/library/notice';
import { splitError } from '@/library/scan';
import { colorOf } from '@/look/color';
import { noteName } from '@/score/pitch';
import { useDark } from '@/look/use-dark';
import { tempoLabel } from '@/play/settings';
import { keyOf, modeOf, type Key } from '@/score/key';
import { RangeStrip } from '@/screens/range-strip';
import { commands, type PieceRow, type PlayRow } from '@/bindings';
import { Ellipsis, Star } from 'lucide-react';
import { useEffect, useState } from 'react';

/** Title, facts, the keys the piece uses, the buttons that open it and its history. */
export function Detail({
  piece,
  folder,
  onFavorite,
  onDelete,
  onPlay,
  onPreview,
}: {
  piece: PieceRow;
  folder: string | null;
  onFavorite: () => void;
  onDelete: () => void;
  onPlay: (path: string, intent: 'practice' | 'performance') => void;
  onPreview: (path: string) => void;
}) {
  const broken = !!piece.error;
  const key = pieceKey(piece);
  const tonic = key && key.tonic;
  const fullPath = folder ? pathOf(folder, piece.path) : piece.path;
  return (
    <div className="flex-1 overflow-y-auto px-12 py-10">
      <div className="flex max-w-[960px] flex-col select-text">
        {/* The title line holds the title and everything that opens or changes the piece; the
            composer and the meta line span the column under it. */}
        <div className="flex items-start justify-between gap-4">
          <h2 className="min-w-0 text-[28px] leading-tight font-semibold tracking-tight break-words">
            {piece.title ?? piece.path}
          </h2>
          <div className="flex flex-none items-center gap-1.5 pt-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Favorite"
              aria-pressed={!!piece.favorite}
              className={`duration-100 motion-reduce:transition-none ${piece.favorite ? '' : 'text-muted-ink'}`}
              onClick={onFavorite}
            >
              <Star className={piece.favorite ? 'fill-current' : ''} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={broken || !folder}
              onClick={() => onPreview(piece.path)}
            >
              Preview
            </Button>
            {/* Practice is the filled one: a piece starts there, and a Performance is for when it
                is ready. */}
            <Button
              size="sm"
              disabled={broken || !folder}
              onClick={() => onPlay(piece.path, 'practice')}
            >
              Practice
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={broken || !folder}
              onClick={() => onPlay(piece.path, 'performance')}
            >
              Perform
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="More">
                  <Ellipsis />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* The whole path is here alone, as the tooltip of the one action that uses it. */}
                <DropdownMenuItem
                  className="text-[13px]"
                  title={fullPath}
                  onSelect={() =>
                    void commands.revealInFinder(fullPath).catch((error) =>
                      setNotice(`Could not reveal ${piece.title ?? piece.path}: ${reasonOf(error)}`),
                    )
                  }
                >
                  Reveal in Finder
                </DropdownMenuItem>
                <DropdownMenuItem className="text-[13px]" disabled={!folder} onSelect={onDelete}>
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {piece.composer && (
          <p className="text-muted-ink mt-1 text-[15px] font-normal">{piece.composer}</p>
        )}

        <div className="text-muted-ink mt-2 flex min-w-0 items-baseline gap-2.5 text-[12px]">
          {partText(piece) && <span className="flex-none">{partText(piece)}</span>}
          <span className="min-w-0 truncate">{baseNameOf(piece.path)}</span>
        </div>

        {broken ? (
          <div className="mt-7 flex flex-col gap-1.5 text-[13px]">
            <b className="font-semibold">{splitError(piece.error!).reason}</b>
            <details className="text-muted-ink text-[12px]">
              <summary className="cursor-pointer">Details</summary>
              <code className="mt-1 block text-[11.5px] whitespace-pre-wrap">
                {splitError(piece.error!).detail}
              </code>
            </details>
          </div>
        ) : (
          <>
            <div className="mt-7 max-w-[640px]">
              <RangeStrip
                lo={piece.midi_lo ?? 21}
                hi={piece.midi_hi ?? 108}
                tonic={tonic}
              />
            </div>
            <Facts piece={piece} keyAt={key} />
          </>
        )}

        <div className="mt-12 max-w-[640px]">
          <History piece={piece} />
        </div>
      </div>
    </div>
  );
}

/**
 * What the piece has been played: the summary over the ledger of the last six plays. A practice
 * shows its time, a performance the settings it ran at and its grade.
 */
function History({ piece }: { piece: PieceRow }) {
  const [plays, setPlays] = useState<PlayRow[]>([]);

  useEffect(() => {
    let live = true;
    void commands.pieceRecentPlays(piece.path, 6).then((rows) => {
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
  const tempo = value === null ? '' : tempoLabel(mode === 'bpm' ? 'bpm' : 'percent', value);
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
function Facts({ piece, keyAt }: { piece: PieceRow; keyAt: Key | null }) {
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
      keyAt && (
        <span key="key" className="flex items-center gap-1.5">
          <TonicDot midi={60 + keyAt.tonic} />
          {keyAt.name}
        </span>
      ),
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

/** What the meta line says about the part: the name when the file gives a real one, the count alone
 * when it gives a placeholder, and nothing for a piece of one part. */
export function partText(piece: PieceRow): string {
  if ((piece.part_count ?? 1) < 2) return '';
  const parts = `1 of ${piece.part_count} parts`;
  const name = piece.part_name ?? '';
  return genericPart(name) ? parts : `${name}, ${parts}`;
}

/** One word a file writes in place of a part name: a bare number, or a label with an optional
 * number after it, such as "P1", "Instr." or "Staff 2". */
const GENERIC_WORD = /^(?:\d+|(?:musicxml|p|part|instr|instrument|staff|track)\.?\d*)$/i;

/** Whether a part name is made of such words alone, however many, so "Instr. P1" is as made up as
 * "P1" and "Piano right hand" is a real name. */
export function genericPart(name: string): boolean {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => GENERIC_WORD.test(word));
}

/** The key of the index; a piece never indexed has none. */
function pieceKey(piece: PieceRow): Key | null {
  if (piece.key_sharps === null || piece.key_mode === null) return null;
  return keyOf(piece.key_sharps, modeOf(piece.key_mode));
}

/** The first tempo mark of the index, told apart from a tempo that goes on changing after it. */
export function tempoText(
  piece: Pick<PieceRow, 'has_tempo' | 'constant_tempo' | 'tempo_bpm'>,
): string | null {
  if (piece.has_tempo === null) return null;
  if (!piece.has_tempo) return 'no tempo mark';
  if (piece.tempo_bpm === null) return null;
  const bpm = `♩ = ${Math.round(piece.tempo_bpm)}`;
  return piece.constant_tempo ? bpm : `${bpm}, varies`;
}

function duration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = `${minutes % 60}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
  return minutes < 60 ? rest : `${Math.floor(minutes / 60)}:${rest.padStart(5, '0')}`;
}

