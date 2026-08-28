// The Sound tab's Touch section: how hard a key is struck against how loud the instrument plays
// it. Both sliders reach the engine ahead of the instrument, so a key pressed while the panel is
// open sounds through whatever they currently say and the curve is set by ear.
//
// This is not the mixer's keyboard fader. The fader trims the finished sound after the effects;
// the curve changes what the instrument is asked to play, which is why a soft strike under a soft
// curve sounds soft rather than merely quiet. Neither of them touches `velocity_offset`, which is
// a grading calibration and never reaches the engine.

import { curveOf, curved, positionOf } from '@/audio/curve';
import { readSettings, setSetting } from '@/db/db';
import { rowId } from '@/lib/utils';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

/**
 * The two ends of the velocity mapping, beside a plot of what they make. `velocity` is the last
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
  const [values, setValues] = useState<{ floor: number; curve: number } | null>(null);

  useEffect(() => {
    let live = true;
    readSettings().then(
      (settings) =>
        live && setValues({ floor: settings.velocity_floor, curve: settings.velocity_curve }),
      console.error,
    );
    return () => {
      live = false;
    };
  }, []);

  /** Straight into the running engine, so the next strike answers the slider that just moved. */
  function apply(next: { floor: number; curve: number }): void {
    setValues(next);
    invoke('audio_set_velocity_curve', next).catch(console.error);
  }

  function writeFloor(floor: number): void {
    if (!values) return;
    apply({ ...values, floor });
    setSetting('velocity_floor', floor).catch(console.error);
  }

  function writeCurve(position: number): void {
    if (!values) return;
    const curve = curveOf(position);
    apply({ ...values, curve });
    setSetting('velocity_curve', curve).catch(console.error);
  }

  const floor = values?.floor ?? 0;
  const curve = values?.curve ?? 1;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Touch</h3>

      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <Knob
            id="velocity_floor"
            marked={marked}
            label="Softest note volume"
            value={floor}
            readout={`${floor}%`}
            disabled={!values}
            onChange={writeFloor}
          />
          <Knob
            id="velocity_curve"
            marked={marked}
            label="Velocity curve"
            value={positionOf(curve)}
            readout={curve.toFixed(2)}
            disabled={!values}
            onChange={writeCurve}
          />
        </div>
        <CurvePlot floor={floor} curve={curve} velocity={velocity ?? null} />
      </div>
    </section>
  );
}

function Knob({
  id,
  marked,
  label,
  value,
  readout,
  disabled,
  onChange,
}: {
  id: string;
  marked?: string | null;
  label: string;
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
        min={0}
        max={100}
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
 * The curve, small, beside the sliders that make it. The dot is the last strike: how hard it was
 * across, how loud it came out up, so the gap above it is the headroom left in the hands.
 */
function CurvePlot({
  floor,
  curve,
  velocity,
}: {
  floor: number;
  curve: number;
  velocity: number | null;
}) {
  // Inset, so that the dot at either end of the curve is drawn whole rather than half off the box.
  const inset = (part: number) => 8 + part * 84;
  const across = (each: number) => inset((each - 1) / 126);
  const up = (each: number) => inset(1 - curved(each, floor, curve) / 127);
  const path = Array.from({ length: STEPS + 1 }, (_, step) => {
    const each = Math.round(1 + (step * 126) / STEPS);
    return `${across(each).toFixed(1)},${up(each).toFixed(1)}`;
  }).join(' ');

  return (
    <svg
      viewBox="0 0 100 100"
      role="img"
      aria-label="The velocity curve, with the last strike marked"
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
          cx={across(velocity)}
          cy={up(velocity)}
          r={7}
          fill="currentColor"
        />
      )}
    </svg>
  );
}
