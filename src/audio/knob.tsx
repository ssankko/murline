// One labelled slider row of the Sound tab, with its readout on the right. The Touch and Envelope
// sections are both a column of these beside a plot, so the row itself lives here.

import { rowId } from '@/lib/utils';

/**
 * `id` is the settings id the search catalogue knows, which is what a search result marks and
 * scrolls to. `readout` is the value in whatever unit the row speaks, already worded.
 */
export function Knob({
  id,
  marked,
  label,
  lo,
  hi,
  value,
  readout,
  disabled,
  onChange,
}: {
  id: string;
  marked?: string | null;
  label: string;
  lo: number;
  hi: number;
  value: number;
  readout: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label
      id={rowId(id)}
      data-marked={marked === id || undefined}
      className={`flex min-h-8 items-center gap-2 py-1 text-[12px] ${marked === id ? 'bg-ink/8' : ''}`}
    >
      <span className="flex-none whitespace-nowrap">{label}</span>
      <input
        type="range"
        aria-label={label}
        min={lo}
        max={hi}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="accent-ink ml-auto min-w-0 flex-1 disabled:opacity-30"
      />
      <span className="text-muted-ink w-8 flex-none text-right text-[11px] tabular-nums">
        {readout}
      </span>
    </label>
  );
}
