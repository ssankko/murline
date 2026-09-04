// The controls the Look, Playing and Library tabs share: a heading over a group of rows, a folder
// path with its chooser, and the two note dropdowns of a custom keyboard range.

import { Button } from "@/components/ui/button";
import { useMidiStatus } from "@/midi/use-midi-status";
import { noteName } from "@/score/pitch";
import { set, type Settings } from "@/settings/settings";
import { useState } from "react";

/** The whole keyboard, the span both note dropdowns offer. */
const NOTES = Array.from({ length: 88 }, (_, at) => 21 + at);

/** The `value` and `onChange` of a control writing straight to one setting. */
export function bind<K extends keyof Settings>(values: Settings, key: K) {
  return { value: values[key], onChange: (value: Settings[K]) => void set(key, value) };
}

/** One heading over one group of rows, on the Look and Playing tabs. */
export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[13px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

export function Path({ value, onChoose }: { value: string; onChoose: () => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="text-muted-ink truncate text-[11.5px] select-text">
        {value || "not set"}
      </code>
      <Button
        variant="outline"
        size="sm"
        className="h-7 flex-none"
        onClick={onChoose}
      >
        Choose…
      </Button>
    </div>
  );
}

/**
 * A custom keyboard range: the two ends, and the two strikes that read them off the keyboard. The
 * next strike is the low end, the one after it the high end, in whichever order they come.
 */
export function CustomRange({
  lo,
  hi,
  onChange,
}: {
  lo: number;
  hi: number;
  onChange: (lo: number, hi: number) => void;
}) {
  /** The first of the two strikes "Detect from keyboard" is waiting for, if it has come. */
  const [detecting, setDetecting] = useState<{ first: number | null } | null>(
    null,
  );

  useMidiStatus((event) => {
    if (!detecting || !event.on) return;
    if (detecting.first === null) return setDetecting({ first: event.midi });
    setDetecting(null);
    onChange(
      Math.min(detecting.first, event.midi),
      Math.max(detecting.first, event.midi),
    );
  });

  return (
    <div className="flex flex-none flex-col items-start gap-1.5">
      {/* The low end never passes the high one. */}
      <div className="flex flex-none items-center gap-1.5">
        <NoteSelect
          label="Lowest key"
          value={lo}
          onChange={(next) => onChange(next, Math.max(next, hi))}
        />
        <span className="text-muted-ink text-[12px]">to</span>
        <NoteSelect
          label="Highest key"
          value={hi}
          onChange={(next) => onChange(Math.min(lo, next), next)}
        />
      </div>
      <button
        onClick={() => setDetecting({ first: null })}
        className="text-muted-ink hover:text-ink text-[12px] underline underline-offset-2"
      >
        {detecting
          ? detecting.first === null
            ? "Strike the lowest and the highest key…"
            : "Now the other end…"
          : "Detect from keyboard"}
      </button>
    </div>
  );
}

function NoteSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
      className="border-edge h-7 border bg-transparent px-1.5 text-[12px]"
    >
      {NOTES.map((midi) => (
        <option key={midi} value={midi}>
          {noteName(midi)}
        </option>
      ))}
    </select>
  );
}
