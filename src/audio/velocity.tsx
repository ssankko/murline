// The Sound tab's Touch section: the remap from the velocity the keyboard sends to the velocity
// the app works in. All three controls reach the engine ahead of the instrument, so a key pressed
// while the panel is open sounds through whatever they currently say and the remap is set by ear.
//
// This is not the mixer's keyboard fader. The fader trims the finished sound after the effects;
// the remap changes the velocity itself, which is why a soft strike under a soft curve sounds soft
// rather than merely quiet. The same map is put on the strike the webview is told about, so a
// grade reads the output velocity.

import { curveOf, curved, positionOf } from '@/audio/curve';
import { Knob } from '@/audio/knob';
import type { Sounding } from '@/audio/sounding';
import { set, useSetting } from '@/settings/settings';
import { colorOf } from '@/look/color';
import { useDark } from '@/look/use-dark';
import { useState } from 'react';

/**
 * The three controls of the velocity remap, beside a plot of what they make. `sounding` is every
 * key the panel has heard lately, which the plot marks so the player can see how much harder they
 * can still press.
 */
export function VelocitySection({
  marked,
  sounding = [],
}: {
  marked?: string | null;
  sounding?: Sounding[];
}) {
  const min = useSetting('velocity_min');
  const max = useSetting('velocity_max');
  const curve = useSetting('velocity_curve');
  /** Why the engine would not take the last move, shown until one it takes. */
  const [failure, setFailure] = useState('');

  /** Each write reaches the running engine, so the next strike answers the control that moved. */
  const write = (key: 'velocity_min' | 'velocity_max' | 'velocity_curve', value: number) =>
    void set(key, value).then(setFailure);

  // Two independent controls can cross, and a minimum above the maximum is a map that runs
  // backwards, so each one stops at the other.
  const writeMin = (asked: number) => write('velocity_min', Math.min(asked, max));
  const writeMax = (asked: number) => write('velocity_max', Math.max(asked, min));
  const writeCurve = (position: number) => write('velocity_curve', curveOf(position));

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Touch</h3>

      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <Knob
            id="velocity_min"
            marked={marked}
            label="Minimum velocity"
            hint="Velocity 1 lands here."
            lo={1}
            hi={127}
            value={min}
            readout={`${min}`}
            onChange={writeMin}
          />
          <Knob
            id="velocity_max"
            marked={marked}
            label="Maximum velocity"
            hint="Velocity 127 lands here."
            lo={1}
            hi={127}
            value={max}
            readout={`${max}`}
            onChange={writeMax}
          />
          <Knob
            id="velocity_curve"
            marked={marked}
            label="Velocity curve"
            hint="Over 1.00 makes soft playing softer."
            lo={0}
            hi={100}
            value={positionOf(curve)}
            readout={curve.toFixed(2)}
            onChange={writeCurve}
          />
        </div>
        <CurvePlot min={min} max={max} curve={curve} sounding={sounding} />
      </div>
      {failure && <p className="text-muted-ink text-[12px]">{failure}</p>}
    </section>
  );
}

/** How many points the curve is drawn with. Enough that no bend of it reads as a corner. */
const STEPS = 32;

/**
 * The remap, small, beside the controls that make it: input velocity across, output velocity up,
 * both over the full 0 to 127, so a narrow minimum-to-maximum band reads as the band it is. Each
 * dot is a key, in its own pitch colour, and the gap above it is the headroom left in the hands.
 *
 * Strikes arrive already remapped, because the remap governs the whole app, so a dot is put on the
 * curve at the output it is: the map is run backwards to find the input behind it.
 */
function CurvePlot({
  min,
  max,
  curve,
  sounding,
}: {
  min: number;
  max: number;
  curve: number;
  sounding: Sounding[];
}) {
  const dark = useDark();
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
      aria-label="Input velocity against output velocity, with every key lately struck marked"
      className="border-edge-soft size-[68px] flex-none border"
    >
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      {sounding
        .filter((note) => note.velocity > 0)
        .map((note) => (
          <circle
            key={note.midi}
            data-strike={note.velocity}
            cx={across(behind(note.velocity))}
            cy={inset(1 - note.velocity / 127)}
            r={7}
            fill={colorOf(note.midi, 'full', dark)}
          />
        ))}
    </svg>
  );
}
