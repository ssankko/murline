// The detail pane of the library page: what a piece is and what it has been played. Nothing here
// writes; Favorite and Delete are the list pane's, handed down as callbacks.

import { Button } from '@/components/ui/button';
import { pathOf } from '@/library/index-file';
import { reasonOf, setNotice } from '@/library/notice';
import { recentPlays, type PieceRow, type PlayRow } from '@/library/queries';
import { splitError } from '@/library/scan';
import { colorOf, noteName } from '@/look/color';
import { useDark } from '@/look/use-dark';
import { tempoLabel } from '@/play/settings';
import { keyName, tonicOf, type KeyAt } from '@/score/harmony';
import { RangeStrip } from '@/screens/range-strip';
import { invoke } from '@tauri-apps/api/core';
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
  const key = keyOf(piece);
  const tonic = key && tonicOf(key);
  const fullPath = folder ? pathOf(folder, piece.path) : piece.path;
  return (
    <div className="flex-1 overflow-y-auto px-12 py-10">
      <div className="flex max-w-[640px] flex-col select-text">
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
                onClick={() =>
                  void invoke('reveal_in_finder', { path: fullPath }).catch((error) =>
                    setNotice(`Could not reveal ${piece.title ?? piece.path}: ${reasonOf(error)}`),
                  )
                }
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
            <div className="mt-7">
              <RangeStrip
                lo={piece.midi_lo ?? 21}
                hi={piece.midi_hi ?? 108}
                tonic={tonic}
              />
            </div>
            <Facts piece={piece} keyAt={key} />
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

        <div className="mt-12">
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
function Facts({ piece, keyAt }: { piece: PieceRow; keyAt: KeyAt | null }) {
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
        {keyAt && <TonicDot midi={60 + tonicOf(keyAt)} />}
        {keyAt && keyName(keyAt)}
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

/** The key of the index, in the form the harmony works in; a piece never indexed has none. */
function keyOf(piece: PieceRow): KeyAt | null {
  if (piece.key_sharps === null) return null;
  return { tick: 0, sharps: piece.key_sharps, mode: piece.key_mode === 'minor' ? 1 : 0 };
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

