// The rows of the settings panel and of the popovers that share its look: a divided list, one
// labelled row with an optional hint under the label, the segmented control a choice of a few
// takes, and the slider row a number takes. The Sound tab's sections and the panel's own tabs draw
// from here alike.

import { rowId, rowOf, useMarked, type SettingRowId } from '@/settings/rows';

/** The divided list the rows sit in. `top` is the hairline above the first row, which a group
 * standing right under a border of its own leaves off. */
export function Rows({ children, top = true }: { children: React.ReactNode; top?: boolean }) {
  return (
    <div className={`divide-edge-soft border-edge-soft divide-y ${top ? 'border-y' : 'border-b'}`}>
      {children}
    </div>
  );
}

/**
 * One setting: its label on the left, its control on the right. `id` names the row's descriptor,
 * which gives the label and is what a search result marks and scrolls to. A row that only shows a
 * value, such as the latency, has no descriptor and carries its own `label` instead. `hint` is one
 * short line under the label saying what the setting does.
 */
export function Row({
  id,
  label,
  hint,
  children,
}: ({ id: SettingRowId; label?: undefined } | { id?: undefined; label: string }) & {
  hint?: string;
  children: React.ReactNode;
}) {
  const marked = useMarked(id);
  return (
    <div
      id={id && rowId(id)}
      data-marked={marked || undefined}
      className={`flex min-h-8 items-center justify-between gap-3 py-1 text-[12px] ${marked ? 'bg-ink/8' : ''}`}
    >
      <span className={hint ? 'flex min-w-0 flex-col gap-0.5' : 'flex-none'}>
        {id ? rowOf(id).label : label}
        {hint && <span className="text-muted-ink text-[11px] leading-snug">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

/**
 * One number, dragged rather than typed: the label and its hint on the left, the track and the
 * readout on the right. The track is a fixed width, so every slider has one track width and its
 * label takes what the row leaves, as a Row's label does. `readout` is for a row whose slider
 * does not carry the number the row speaks, such as an attack in seconds moved in milliseconds;
 * without one the readout is the value with `unit` after it, written as it is given, so a per cent
 * carries no space and a millisecond does.
 */
export function Slider({
  id,
  hint,
  min,
  max,
  step = 1,
  value,
  unit = '',
  readout,
  disabled,
  onChange,
}: {
  id: SettingRowId;
  hint?: string | undefined;
  min: number;
  max: number;
  step?: number;
  value: number;
  unit?: string;
  readout?: string;
  disabled?: boolean | undefined;
  onChange: (value: number) => void;
}) {
  const marked = useMarked(id);
  const { label } = rowOf(id);
  return (
    <label
      id={rowId(id)}
      data-marked={marked || undefined}
      className={`flex min-h-8 items-center gap-2 py-1 text-[12px] ${marked ? 'bg-ink/8' : ''}`}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {label}
        {hint && <span className="text-muted-ink text-[11px] leading-snug">{hint}</span>}
      </span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="accent-ink w-40 flex-none disabled:opacity-30"
      />
      <span className="text-muted-ink w-14 flex-none text-right text-[11px] whitespace-nowrap tabular-nums">
        {readout ?? `${value}${unit}`}
      </span>
    </label>
  );
}

/**
 * The one shape every choice of a few takes: the active one filled with ink. `allowed` is what may
 * be picked now; every other option is dimmed and dead. An empty or missing list allows everything,
 * and `disabled` deadens the whole control the same way, for a row another setting switches off.
 * `best` is the option the row recommends, dotted in its corner; the row's hint says why.
 */
export function Segmented<T extends string | number | boolean>({
  options,
  value,
  onChange,
  allowed,
  disabled,
  best,
}: {
  options: [T, string][];
  value: T;
  onChange: (value: T) => void;
  allowed?: T[] | undefined;
  disabled?: boolean | undefined;
  best?: T | undefined;
}) {
  return (
    <div className="border-edge flex flex-none border">
      {options.map(([each, label]) => {
        const dead = disabled || (allowed?.length ? !allowed.includes(each) : false);
        return (
          <button
            key={String(each)}
            aria-pressed={value === each}
            aria-disabled={dead}
            disabled={dead}
            title={each === best ? 'Recommended' : undefined}
            onClick={() => onChange(each)}
            className={`relative h-6 px-2 text-[11.5px] font-medium tabular-nums transition-colors duration-150 ${
              value === each ? 'bg-ink text-paper' : 'hover:bg-ink/8'
            } ${dead ? 'opacity-35 hover:bg-transparent' : ''} ${
              each === best
                ? 'after:absolute after:top-1 after:right-1 after:size-1 after:rounded-full after:bg-current'
                : ''
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/** A boolean as a two-way Segmented. */
export function Toggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean | undefined;
}) {
  return (
    <Segmented
      options={[
        [true, 'On'],
        [false, 'Off'],
      ]}
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

/** Numbers as Segmented options, each labelled by itself. */
export function numbered(choices: number[]): [number, string][] {
  return choices.map((choice) => [choice, String(choice)]);
}
