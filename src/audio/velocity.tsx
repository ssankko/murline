// The Sound tab's Touch section: the remap from the velocity the keyboard sends to the velocity
// the app works in. All three controls reach the engine ahead of the instrument, so a key pressed
// while the panel is open sounds through whatever they currently say and the remap is set by ear.
//
// This is not the mixer's keyboard fader. The fader trims the finished sound after the effects;
// the remap changes the velocity itself, which is why a soft strike under a soft curve sounds soft
// rather than merely quiet. The same map is put on the strike the webview is told about, so a
// grade reads the output velocity. `velocity_offset` is a further grading calibration on top.

import { curveOf, curved, positionOf } from '@/audio/curve';
import { readSettings, setSetting } from '@/db/db';
import { rowId } from '@/lib/utils';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

type Remap = { min: number; max: number; curve: number };

/**
 * The three controls of the velocity remap, beside a plot of what they make. `velocity` is the last
 * strike the panel heard, which the plot marks so the player can see how much harder they can
 * still press.
 */
export function VelocitySection({
  marked,
  velocity,
}: {
  marked?: string | null;
  velocity?: number | null;
}) {
  const [values, setValues] = useState<Remap | null>(null);

  useEffect(() => {
    let live = true;
    readSettings().then(
      (settings) =>
        live &&
        setValues({
          min: settings.velocity_min,
          max: settings.velocity_max,
          curve: settings.velocity_curve,
        }),
      console.error,
    );
    return () => {
      live = false;
    };
  }, []);

  /** Straight into the running engine, so the next strike answers the control that just moved. */
  function apply(next: Remap): void {
    setValues(next);
    invoke('audio_set_velocity_curve', next).catch(console.error);
  }

  // Two independent controls can cross, and a minimum above the maximum is a map that runs
  // backwards, so each one stops at the other.
  function writeMin(asked: number): void {
    if (!values) return;
    const min = Math.min(asked, values.max);
    apply({ ...values, min });
    setSetting('velocity_min', min).catch(console.error);
  }

  function writeMax(asked: number): void {
    if (!values) return;
    const max = Math.max(asked, values.min);
    apply({ ...values, max });
    setSetting('velocity_max', max).catch(console.error);
  }

  function writeCurve(position: number): void {
    if (!values) return;
    const curve = curveOf(position);
    apply({ ...values, curve });
    setSetting('velocity_curve', curve).catch(console.error);
  }

  const min = values?.min ?? 1;
  const max = values?.max ?? 127;
  const curve = values?.curve ?? 1;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Touch</h3>

      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <Knob
            id="velocity_min"
            marked={marked}
            label="Minimum velocity"
            lo={1}
            hi={127}
            value={min}
            readout={`${min}`}
            disabled={!values}
            onChange={writeMin}
          />
          <Knob
            id="velocity_max"
            marked={marked}
            label="Maximum velocity"
            lo={1}
            hi={127}
            value={max}
            readout={`${max}`}
            disabled={!values}
            onChange={writeMax}
          />
          <Knob
            id="velocity_curve"
            marked={marked}
            label="Velocity curve"
            lo={0}
            hi={100}
            value={positionOf(curve)}
            readout={curve.toFixed(2)}
            disabled={!values}
            onChange={writeCurve}
          />
        </div>
        <CurvePlot min={min} max={max} curve={curve} velocity={velocity ?? null} />
      </div>
    </section>
  );
}

function Knob({
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
  disabled: boolean;
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

/** How many points the curve is drawn with. Enough that no bend of it reads as a corner. */
const STEPS = 32;

/**
 * The remap, small, beside the controls that make it: input velocity across, output velocity up,
 * both over the full 0 to 127, so a narrow minimum-to-maximum band reads as the band it is. The
 * dot is the last strike, and the gap above it is the headroom left in the hands.
 *
 * The strike arrives already remapped, because the remap governs the whole app, so the dot is put
 * on the curve at the output it is: the map is run backwards to find the input behind it.
 */
function CurvePlot({
  min,
  max,
  curve,
  velocity,
}: {
  min: number;
  max: number;
  curve: number;
  velocity: number | null;
}) {
  // Inset, so that the dot at either end of the curve is drawn whole rather than half off the box.
  const inset = (part: number) => 8 + part * 84;
  const across = (each: number) => inset((each - 1) / 126);
  const up = (each: number) => inset(1 - curved(each, min, max, curve) / 127);
  const path = Array.from({ length: STEPS + 1 }, (_, step) => {
    const each = Math.round(1 + (step * 126) / STEPS);
    return `${across(each).toFixed(1)},${up(each).toFixed(1)}`;
  }).join(' ');
  // A map with both ends together answers every input with one output and cannot be run backwards;
  // the whole keyboard is behind that dot, so it goes in the middle.
  const behind = (out: number) =>
    max === min ? 64 : 1 + 126 * Math.max(0, (out - min) / (max - min)) ** (1 / curve);

  return (
    <svg
      viewBox="0 0 100 100"
      role="img"
      aria-label="Input velocity against output velocity, with the last strike marked"
      className="border-edge-soft size-[68px] flex-none border"
    >
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      {velocity !== null && velocity > 0 && (
        <circle
          data-strike={velocity}
          cx={across(behind(velocity))}
          cy={inset(1 - velocity / 127)}
          r={7}
          fill="currentColor"
        />
      )}
    </svg>
  );
}
