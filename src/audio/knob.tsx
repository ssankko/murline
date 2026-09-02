// One labelled slider row of the Sound tab, with its hint under the label and its readout on the
// right. The Touch and Envelope sections are both a column of these beside a plot, so the row
// itself lives here. The mixer's two faders are the same row.

import { rowId, rowOf, useMarked, type SettingRowId } from '@/settings/rows';

/**
 * `id` names the row's descriptor, which gives the label and is what a search result marks and
 * scrolls to. `readout` is the value in whatever unit the row speaks, already worded, and `hint`
 * is one short line under the label saying what the row does. The label column is a fixed width,
 * so every knob of a section lines its slider up with the others.
 */
export function Knob({
  id,
  hint,
  lo,
  hi,
  value,
  readout,
  onChange,
}: {
  id: SettingRowId;
  hint?: string | undefined;
  lo: number;
  hi: number;
  value: number;
  readout: string;
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
      <span className="flex w-36 flex-none flex-col gap-0.5">
        {label}
        {hint && <span className="text-muted-ink text-[11px] leading-snug">{hint}</span>}
      </span>
      <input
        type="range"
        aria-label={label}
        min={lo}
        max={hi}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="accent-ink min-w-0 flex-1"
      />
      <span className="text-muted-ink w-8 flex-none text-right text-[11px] tabular-nums">
        {readout}
      </span>
    </label>
  );
}
