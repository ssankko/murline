// The controls every screen's top bar is built from: one 32 px button shape and the tempo popover.

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { colorOf } from '@/look/color';
import { useDark } from '@/look/use-dark';
import { TEMPO_RANGE, tempoLabel, type TempoMode } from '@/play/settings';
import {
  keyName,
  keyTable,
  parallelOf,
  relativeOf,
  signatureOf,
  type KeyAt,
} from '@/score/harmony';
import { Music2 } from 'lucide-react';

/** One size and one stroke for every icon in the bar. */
export const ICON = { size: 18, strokeWidth: 1.75 } as const;

/** The stepper's step. */
export const TEMPO_STEP = 5;

/**
 * The tempo readout and its popover: the mode switch and the slider of the active mode. The
 * readout shows the value the clock runs at, `100 %` or `♩ = 96`.
 */
export function TempoPopover({
  mode,
  value,
  constantTempo,
  onMode,
  onValue,
}: {
  mode: TempoMode;
  value: number;
  /** BPM mode is offered only for a piece written at one tempo; a flat BPM would flatten the rest. */
  constantTempo: boolean;
  onMode: (mode: TempoMode) => void;
  onValue: (value: number) => void;
}) {
  const [min, max] = TEMPO_RANGE[mode];
  const label = tempoLabel(mode, value);
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              aria-label="Tempo"
              className="hover:bg-ink/8 relative flex h-8 flex-none items-center justify-center rounded-md px-1.5 transition-colors duration-150"
            >
              <span className="text-[13px] font-medium tabular-nums">{label}</span>
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">Tempo</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="center" className="flex w-56 flex-col gap-3 p-3">
        <div className="border-edge flex self-start border">
          {(['percent', 'bpm'] as const).map((each) => (
            <button
              key={each}
              aria-label={each === 'bpm' ? 'BPM' : 'Percent'}
              aria-pressed={mode === each}
              disabled={each === 'bpm' && !constantTempo}
              onClick={() => onMode(each)}
              className={`h-6 px-3 text-[12px] font-medium transition-colors duration-150 disabled:text-ink/35 ${
                mode === each ? 'bg-ink text-paper' : 'hover:bg-ink/8'
              }`}
            >
              {each === 'bpm' ? 'BPM' : '%'}
            </button>
          ))}
        </div>
        <input
          type="range"
          aria-label={mode === 'bpm' ? 'Tempo in BPM' : 'Tempo in percent'}
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(event) => onValue(Number(event.target.value))}
          className="accent-ink w-full"
        />
        <div className="text-muted-ink flex justify-between text-[11px] tabular-nums">
          <span>{min}</span>
          <span>{max}</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The three primary degrees, drawn in full ink while the rest of the table stays muted. */
const PRIMARY = new Set([1, 4, 5]);

/**
 * The key readout and its popover: one column per scale degree, holding the degree's number, note
 * and function over its triad, the triad's notes and its seventh chord, under the key's signature,
 * relative and parallel. Nothing is drawn until a score names a key.
 */
export function KeyPopover({ at }: { at: KeyAt | null }) {
  const dark = useDark();
  if (!at) return null;
  const name = keyName(at);
  const { count, notes } = signatureOf(at);
  const signature =
    count === 0
      ? 'no sharps or flats'
      : `${count} ${notes[0]!.endsWith('♯') ? 'sharp' : 'flat'}${count > 1 ? 's' : ''}: ${notes.join(' ')}`;
  const minor = name.endsWith('minor');
  const footer = `${signature} · relative ${keyName(relativeOf(at))} · parallel ${keyName(
    parallelOf(at),
  )}${minor ? ' · harmonic minor' : ''}`;
  const table = keyTable(at);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <BarButton label={`Key: ${name}`} wide>
          <Music2 {...ICON} />
          <span className="ml-1.5 text-[13px] font-medium">{name}</span>
        </BarButton>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-auto p-3">
        <div className="text-[13px] font-medium">{name}</div>
        <table className="mt-2 border-separate border-spacing-x-2 border-spacing-y-1 text-center text-[12px]">
          <thead>
            <tr>
              {table.map((each) => (
                <th
                  key={each.degree}
                  scope="col"
                  className={`font-normal ${PRIMARY.has(each.degree) ? '' : 'text-muted-ink'}`}
                >
                  <div className="text-[11px]">{each.degree}</div>
                  <div
                    className={`text-[13px] font-medium ${PRIMARY.has(each.degree) ? '' : 'opacity-50'}`}
                    style={{ color: colorOf(each.pitch, 'muted', dark) }}
                  >
                    {each.note}
                  </div>
                  <div className="text-[10px]">{each.role}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(['triad', 'notes', 'seventh'] as const).map((row) => (
              <tr key={row}>
                {table.map((each) => (
                  <td
                    key={each.degree}
                    className={`${row === 'triad' ? 'pt-2' : ''} ${PRIMARY.has(each.degree) ? '' : 'text-muted-ink'}`}
                  >
                    {each[row]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-muted-ink mt-2 text-[11px]">{footer}</div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One 32 px shape for every control of the bar. An action is plain ink; a control that is only
 * placed here is `off`, dimmed and inert; a light with nothing to report is `dim`, dimmed but still
 * a way into its settings; a toggle says whether it is on with an under-bar, and one `segment` of a
 * pair says it by filling instead.
 */
export function BarButton({
  label,
  onClick,
  off,
  dim,
  pressed,
  disc,
  wide,
  segment,
  children,
  ...rest
}: {
  label: string;
  onClick?: () => void;
  off?: boolean;
  dim?: boolean;
  pressed?: boolean;
  disc?: boolean;
  wide?: boolean;
  segment?: boolean;
  children: React.ReactNode;
  // What a `PopoverTrigger asChild` puts on its child: the ref, the click and the open state.
} & Omit<React.ComponentProps<'button'>, 'onClick' | 'children'>) {
  // A segment sits square inside the pair's shared border and fills when it is the active side;
  // every other toggle is dimmed while off and full ink with an under-bar while on. A control only
  // placed here is `off`: dimmed and inert.
  const filled = segment && pressed;
  const dimmed = off || dim || (!segment && pressed === false);
  const paint = filled
    ? 'bg-ink text-paper'
    : `${dimmed ? 'text-ink/35' : ''} ${off ? '' : 'hover:bg-ink/8'}`;
  const shape = disc
    ? 'size-[34px] rounded-full bg-ink text-paper mx-1 hover:bg-ink/85'
    : `h-8 ${segment ? 'rounded-none' : 'rounded-md'} ${wide ? 'px-1.5' : 'w-8'} ${paint}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          {...rest}
          aria-label={label}
          aria-disabled={off || undefined}
          aria-pressed={pressed}
          onClick={off ? undefined : onClick}
          className={`relative flex flex-none items-center justify-center transition-colors duration-150 ${shape}`}
        >
          {children}
          {pressed && !segment && (
            <i className="bg-current absolute right-2 bottom-0.5 left-2 h-0.5" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
