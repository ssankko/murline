// The metronome icon of the play bar, drawn as a sibling of the lucide icons. Only the `on` prop
// renders: the frame loop drives the swing and the pulse through the handle, so a beat costs no
// render.

import { EASE, reducedMotion } from '@/look/motion';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';

/** How far the arm leans to either side of upright on a beat, in degrees. */
const SWING = 35;
/** Where the arm stands while the beats run, measured from the lean the icon is drawn with. */
const UPRIGHT = -45;
/** How long the arm takes to reach its resting angle once the beats stop. */
const REST_MS = 300;
/** How long after a beat, in beats of its own, the icon calls the play stopped. */
const REST_AFTER = 1.5;
const PULSE_MS = 200;
/** How much the icon swells at the top of a pulse, on the beat a bar opens with and on the rest. */
const PEAK = { strong: 1.56, weak: 1.24 };
/** The value of `--ease`, written out because an animation cannot read a variable. */
const CURVE = 'cubic-bezier(0.65, 0, 0.35, 1)';
/** A pendulum's two halves: it slows into the end of its swing and gathers speed back to centre. */
const OUT = 'cubic-bezier(0.33, 1, 0.68, 1)';
const BACK = 'cubic-bezier(0.32, 0, 0.67, 0)';
/** The rise of a pulse: away fast, then all the way out. */
const SWELL = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** What the frame loop drives the icon with, once for every beat the engine owes. */
export interface MetronomeHandle {
  /** `periodMs` is the beat the swing takes, so the arm is upright again on the next beat. */
  tick(strong: boolean, periodMs: number): void;
}

export function Metronome({
  ref,
  on,
  size = 18,
  strokeWidth = 1.75,
}: {
  ref?: Ref<MetronomeHandle>;
  /** The arm rests upright while the metronome is on, and aside while it is off. */
  on: boolean;
  size?: number;
  strokeWidth?: number;
}) {
  const bodyRef = useRef<SVGSVGElement>(null);
  const armRef = useRef<SVGGElement>(null);
  /** Which side the arm swings to: every beat sends it to the other one. */
  const lean = useRef(1);
  const resting = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Beats arrive through a handle that outlives any render, so the rest angle is read from here.
  const onRef = useRef(on);
  onRef.current = on;

  /** Turns the arm to where it waits for the next beat, or stays if the beats keep coming. */
  function rest(): void {
    const arm = armRef.current;
    if (!arm) return;
    arm.style.transition = reducedMotion() ? '' : `transform ${REST_MS}ms ${EASE}`;
    arm.style.transform = `rotate(${onRef.current ? UPRIGHT : 0}deg)`;
  }

  useEffect(() => {
    rest();
    return () => clearTimeout(resting.current);
  }, [on]);

  useImperativeHandle(ref, () => ({
    tick(strong, periodMs) {
      const arm = armRef.current;
      const body = bodyRef.current;
      if (!arm || !body || reducedMotion()) return;
      lean.current = -lean.current;
      // A swing still running is dropped, so however close two beats fall each one is its own.
      for (const running of arm.getAnimations()) running.cancel();
      arm.style.transition = '';
      arm.style.transform = `rotate(${UPRIGHT}deg)`;
      arm.animate(
        [
          { transform: `rotate(${UPRIGHT}deg)`, easing: OUT },
          { transform: `rotate(${UPRIGHT + lean.current * SWING}deg)`, offset: 0.5, easing: BACK },
          { transform: `rotate(${UPRIGHT}deg)` },
        ],
        { duration: Math.round(periodMs) },
      );
      for (const running of body.getAnimations()) running.cancel();
      body.animate(
        [
          { transform: 'scale(1)', easing: SWELL },
          { transform: `scale(${strong ? PEAK.strong : PEAK.weak})`, offset: 0.3, easing: CURVE },
          { transform: 'scale(1)' },
        ],
        { duration: PULSE_MS },
      );
      // Nothing announces a pause or the metronome going off, so a beat that never comes is what
      // sends the arm to its rest.
      clearTimeout(resting.current);
      resting.current = setTimeout(rest, periodMs * REST_AFTER);
    },
  }), []);

  return (
    <svg
      ref={bodyRef}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // The pulse and the upright arm both reach past the 24-unit box and past the bar button.
      className="overflow-visible"
    >
      {/* The closed case and the mark of the arm's slot; the arm's own outline cuts the case. */}
      <path d="m15.05 5.7-.218-.691a3 3 0 0 0-5.663 0L4.418 19.695A1 1 0 0 0 5.37 21h13.253a1 1 0 0 0 .951-1.31L18.45 16.2Z" />
      <path d="M12 11.4V9.1" />
      {/* The arm and its weight, turning about the pivot at the foot of the case. The pair is drawn
          twice, the first in the colour of the bar behind it, so it cuts the case where it crosses. */}
      <g ref={armRef} style={{ transformBox: 'view-box', transformOrigin: '12px 17px' }}>
        <g stroke="var(--chrome)" strokeWidth={strokeWidth * 2.5}>
          <path d="m12 17 6.59-6.59" />
          <circle cx="20" cy="9" r="2" />
        </g>
        <path d="m12 17 6.59-6.59" />
        <circle cx="20" cy="9" r="2" />
      </g>
    </svg>
  );
}
