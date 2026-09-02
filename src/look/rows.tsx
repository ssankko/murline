// The rows of the settings panel and of the popovers that share its look: a divided list, one
// labelled row with an optional hint under the label, and the segmented control a choice of a few
// takes. The Sound tab's sections and the panel's own tabs draw from here alike.

import { rowId, rowOf, useMarked, type SettingRowId } from '@/settings/rows';

/** The divided list the rows sit in. */
export function Rows({ children }: { children: React.ReactNode }) {
  return <div className="divide-edge-soft border-edge-soft divide-y border-y">{children}</div>;
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
 * The one shape every choice of a few takes: the active one filled with ink. `allowed` is what may
 * be picked now; every other option is dimmed and dead. An empty or missing list allows everything,
 * and `disabled` deadens the whole control the same way, for a row another setting switches off.
 */
export function Segmented<T extends string | number | boolean>({
  options,
  value,
  onChange,
  allowed,
  disabled,
}: {
  options: [T, string][];
  value: T;
  onChange: (value: T) => void;
  allowed?: T[] | undefined;
  disabled?: boolean | undefined;
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
            onClick={() => onChange(each)}
            className={`h-6 px-2 text-[11.5px] font-medium tabular-nums transition-colors duration-150 ${
              value === each ? 'bg-ink text-paper' : 'hover:bg-ink/8'
            } ${dead ? 'opacity-35 hover:bg-transparent' : ''}`}
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
