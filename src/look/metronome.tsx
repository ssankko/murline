// The metronome icon of the play bar, drawn as a sibling of the lucide icons. It keeps no React
// state: the frame loop drives it beat by beat through its handle, so a tick costs no render.

import { EASE, reducedMotion } from '@/look/motion';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';

/** How far the arm leans at either end of its swing, in degrees. */
const SWING = 22;
/** How long the arm takes to come upright once the beats stop. */
const REST_MS = 300;
/** How long after a beat, in beats of its own, the icon calls the play stopped. */
const REST_AFTER = 1.5;
const PULSE_MS = 180;
/** How much the icon swells at the top of a pulse, on the beat a bar opens with and on the rest. */
const PEAK = { strong: 1.28, weak: 1.12 };
/** The pulse's curve: a quick swell that eases back with a little overshoot. */
const PULSE_EASE = 'cubic-bezier(0.22, 1.3, 0.36, 1)';

/** What the frame loop drives the icon with, once for every beat the engine owes. */
export interface MetronomeHandle {
  /** `periodMs` is the beat the swing takes, so the arm arrives at its end on the next beat. */
  tick(strong: boolean, periodMs: number): void;
}

export function Metronome({
  ref,
  size = 18,
  strokeWidth = 1.75,
}: {
  ref?: Ref<MetronomeHandle>;
  size?: number;
  strokeWidth?: number;
}) {
  const bodyRef = useRef<SVGSVGElement>(null);
  const armRef = useRef<SVGGElement>(null);
  /** Which side the arm leans to: every beat sends it to the other one. */
  const lean = useRef(1);
  const resting = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(resting.current), []);

  useImperativeHandle(ref, () => ({
    tick(strong, periodMs) {
      const arm = armRef.current;
      const body = bodyRef.current;
      if (!arm || !body || reducedMotion()) return;
      lean.current = -lean.current;
      arm.style.transition = `transform ${Math.round(periodMs)}ms ${EASE}`;
      arm.style.transform = `rotate(${lean.current * SWING}deg)`;
      // A pulse still running is dropped, so however close two beats fall each one is its own pulse.
      for (const running of body.getAnimations()) running.cancel();
      body.animate(
        [
          { transform: 'scale(1)' },
          { transform: `scale(${strong ? PEAK.strong : PEAK.weak})`, offset: 0.3 },
          { transform: 'scale(1)' },
        ],
        { duration: PULSE_MS, easing: PULSE_EASE },
      );
      // Nothing announces a pause or the metronome going off, so a beat that never comes is what
      // brings the arm home.
      clearTimeout(resting.current);
      resting.current = setTimeout(() => {
        arm.style.transition = `transform ${REST_MS}ms ${EASE}`;
        arm.style.transform = 'rotate(0deg)';
      }, periodMs * REST_AFTER);
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
      // The pulse and the leaning arm both reach past the 24-unit box and past the bar button.
      className="overflow-visible"
    >
      {/* The case, open at the top for the arm to come out of. */}
      <path d="M10.5 10.5 5 21h14L13.5 10.5" />
      {/* The arm and its weight, drawn from the pivot at the foot of the case, which it turns about. */}
      <g transform="translate(12 19.5)">
        <g ref={armRef} style={{ transformBox: 'view-box', transformOrigin: '0 0' }}>
          <path d="M0 0V-16" />
          <circle cx="0" cy="-11" r="1.5" />
        </g>
      </g>
    </svg>
  );
}
