// The loading indicator: the falling lane's countdown, running on its own. A capsule for the
// strong beat and three dots for the weak ones travel to the right, the one at the right burning
// out on its beat while a new one is born at the left, for as long as the wait lasts. The row
// starts and stops on a beat, never between two, so it keeps its pulse to its last frame.

import { reducedMotion } from '@/look/motion';
import { useEffect, useRef, useState } from 'react';

/** How long one beat lasts, and the beats a mark lives through, which is the marks in the row. */
const BEAT_MS = 250;
const BEATS = 4;
/** A mark's width, a capsule's height, and the step to the next mark, as the lane draws them. */
const MARK = 4;
const TALL = 8;
const STEP = 6;
/**
 * A mark burning out on its beat: the share of the beat the whole burn takes, the share of the
 * burn its collapse takes, and how far it swells before it goes.
 */
const BURN = 0.25;
const COLLAPSE = 0.18;
const SWELL = 1.3;
/** The ink a resting mark wears, the dip its burn opens with, and the flare it peaks at. */
const REST = 0.55;
const DIP = 0.3;
/** The share of a beat a step to the right takes, and the share a birth takes. */
const TRAVEL = 0.4;
const BIRTH = 0.12;
/** A movement that overshoots its stop and settles back into it. */
const ELASTIC = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
/** How long the row's exit takes, and how far right it carries each mark out of the row. */
const EXIT_MS = 200;
const EXIT = STEP * 2;

/** The width the row of marks needs, which every caller lays out around. */
const WIDTH = (BEATS - 1) * STEP + MARK;

/**
 * One mark's whole life, in fractions of the row's cycle: born at the left, a step right on each
 * beat after it, then the burn that takes it off the right end.
 */
function life(): Keyframe[] {
  const at = (beats: number) => beats / BEATS;
  const frames: Keyframe[] = [
    { offset: 0, transform: 'translateX(0px) scale(0)', opacity: 0, easing: ELASTIC },
    { offset: at(BIRTH), transform: 'translateX(0px) scale(1)', opacity: REST },
  ];
  for (let step = 1; step < BEATS; step++) {
    frames.push(
      {
        offset: at(step),
        transform: `translateX(${(step - 1) * STEP}px) scale(1)`,
        easing: ELASTIC,
      },
      { offset: at(step + TRAVEL), transform: `translateX(${step * STEP}px) scale(1)` },
    );
  }
  const end = `translateX(${(BEATS - 1) * STEP}px)`;
  frames.push(
    { offset: at(BEATS - BURN), transform: `${end} scale(1)`, opacity: REST },
    { offset: at(BEATS - BURN * 0.6), transform: `${end} scale(1.1)`, opacity: DIP },
    { offset: at(BEATS - BURN * COLLAPSE), transform: `${end} scale(${SWELL})`, opacity: 1 },
    { offset: 1, transform: `${end} scale(0)`, opacity: 0 },
  );
  return frames;
}

/**
 * The exit, run on a beat: every mark leaves to the right from wherever the beat left it, on the
 * same overshoot the row travels on. The beat is stopped once its last places are read off it.
 */
function leave(marks: HTMLElement[], beat: Animation[]): Animation[] {
  const stands = marks.map((mark) => {
    const style = getComputedStyle(mark);
    const { m41: x, m11: scale } = new DOMMatrixReadOnly(style.transform);
    return { x, scale, opacity: Number(style.opacity) };
  });
  for (const animation of beat) animation.cancel();
  return marks.map((mark, at) => {
    const { x, scale, opacity } = stands[at]!;
    return mark.animate(
      [
        { transform: `translateX(${x}px) scale(${scale})`, opacity },
        { transform: `translateX(${x + EXIT}px) scale(${scale})`, opacity: 0 },
      ],
      { duration: EXIT_MS, easing: ELASTIC, fill: 'forwards' },
    );
  });
}

/**
 * Shown while something the user asked for is still coming, such as an instrument being loaded.
 * The parent leaves it mounted and holds `on` for as long as it waits; the row then runs to the
 * next beat and leaves on it, and is on the page nowhere else. `label` is what a screen reader
 * says it is waiting for. Motion turned down takes the row away the moment the wait ends.
 */
export function Loading({ on = true, label = 'Loading' }: { on?: boolean; label?: string }) {
  const row = useRef<HTMLSpanElement>(null);
  /** What the row is under: its beat while the wait runs, its exit while it leaves. */
  const running = useRef<Animation[]>([]);
  /** The row outlives `on` by its exit, which is what this holds it on the page for. */
  const [drawn, setDrawn] = useState(on);

  useEffect(() => {
    if (on) setDrawn(true);
  }, [on]);

  const marks = (): HTMLElement[] => [
    ...(row.current?.querySelectorAll<HTMLElement>('[data-beat]') ?? []),
  ];

  // Each mark is one beat older than the one before it, so the row holds every age at once and
  // every fourth birth is the capsule. A wait that begins again mid-exit takes the marks back.
  useEffect(() => {
    if (!drawn || !on || reducedMotion()) return;
    for (const animation of running.current) animation.cancel();
    running.current = marks().map((mark, beat) =>
      mark.animate(life(), {
        duration: BEAT_MS * BEATS,
        iterations: Infinity,
        delay: -beat * BEAT_MS,
      }),
    );
  }, [drawn, on]);

  useEffect(() => {
    if (on || !drawn) return;
    if (reducedMotion()) {
      setDrawn(false);
      return;
    }
    // The beat the row is on says how much of this one is left, which is what it runs out first.
    const played = Number(running.current[0]?.currentTime ?? 0);
    const timer = setTimeout(() => {
      running.current = leave(marks(), running.current);
      const last = running.current[0];
      if (last) last.onfinish = () => setDrawn(false);
      else setDrawn(false);
    }, BEAT_MS - (played % BEAT_MS));
    return () => clearTimeout(timer);
  }, [on, drawn]);

  if (!drawn) return null;

  return (
    <span
      ref={row}
      role="status"
      className="flex-none align-middle"
      style={{ position: 'relative', display: 'inline-block', width: WIDTH, height: TALL }}
    >
      {Array.from({ length: BEATS }, (_, beat) => (
        <span
          key={beat}
          data-beat={beat === 0 ? 'strong' : 'weak'}
          className="bg-ink"
          // A mark stands where its own age puts it, which is where it rests while motion is
          // turned down. Its geometry is written here, so the row draws whole with no stylesheet.
          style={{
            position: 'absolute',
            insetBlock: 0,
            marginBlock: 'auto',
            borderRadius: MARK,
            width: MARK,
            height: beat === 0 ? TALL : MARK,
            opacity: REST,
            transform: `translateX(${beat * STEP}px)`,
          }}
        />
      ))}
      <span className="sr-only">{label}</span>
    </span>
  );
}
