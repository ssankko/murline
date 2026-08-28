// The Sound tab's Envelope section: how a sampler instrument's loudness answers a key, and a plot
// of it that a key press travels along as it is played.
//
// Only the sampler has one to offer. A hosted Audio Unit shapes its own notes behind its own
// window, and the engine answers null for it, which is what hides this section.
//
// The engine takes about a second to accept an envelope, however small the change, and goes quiet
// for it, so a moving slider is not sent straight through the way the velocity remap is. The plot
// follows the slider at once and the engine is told once the hand comes to rest. That second of
// silence is long enough to be alarming unasked for, so the section says so from the moment a
// slider moves, through the wait and the second itself, rather than only while the engine has it.

import { Knob } from '@/audio/knob';
import type { Sounding } from '@/audio/sounding';
import { getSettingOr, setSetting } from '@/db/db';
import { colorOf } from '@/look/color';
import { useDark } from '@/look/use-dark';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';

/** Seconds, except `sustain`, which is the fraction of full loudness a held note settles at. */
export interface Envelope {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

/** How long the engine is left alone for after a slider stops moving, in milliseconds. */
const REST = 250;

/**
 * Puts the envelope kept for an instrument back on the engine. Called after every load, because a
 * load reads the instrument file's own envelope in over whatever was set. An instrument never
 * given one keeps the envelope its file asks for.
 */
export async function restoreEnvelope(id: string): Promise<void> {
  const kept = (await getSettingOr('instrument_envelopes'))[id];
  if (kept) await invoke('audio_set_envelope', { envelope: kept });
}

/**
 * `instrument` is the id the envelope is kept under, and `round` goes up whenever the instrument
 * changed, which is when the engine has a different envelope to report. `sounding` is every key
 * under the hands, which the plot walks a dot along for, and `onRelease` is how the tab is told
 * how long one of them takes to die away.
 */
export function EnvelopeSection({
  marked,
  sounding = [],
  onRelease,
  instrument,
  round = 0,
}: {
  marked?: string | null;
  sounding?: Sounding[];
  onRelease?: (seconds: number) => void;
  instrument?: string | null;
  round?: number;
}) {
  const [values, setValues] = useState<Envelope | null>(null);
  const resting = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Counted, not a flag: a second change can go in while the first is still being taken, and the
  // first one finishing must not clear the line the second one is still waiting behind.
  const [taking, setTaking] = useState(0);

  // Null is the answer for a plugin and for no instrument at all, and it is what hides the section.
  useEffect(() => {
    let live = true;
    invoke<Envelope | null>('audio_envelope').then(
      (answer) => live && setValues(answer),
      () => live && setValues(null),
    );
    return () => {
      live = false;
    };
  }, [round]);

  useEffect(() => () => clearTimeout(resting.current), []);

  const release = values?.release;
  useEffect(() => {
    if (release !== undefined) onRelease?.(release);
  }, [release, onRelease]);

  function write(next: Envelope): void {
    setValues(next);
    // The count goes up here rather than when the engine is called, so the warning is up from the
    // first touch of a slider. A change made while one is already waiting joins that one.
    if (resting.current === undefined) setTaking((many) => many + 1);
    else clearTimeout(resting.current);
    resting.current = setTimeout(() => {
      resting.current = undefined;
      invoke('audio_set_envelope', { envelope: next })
        .catch(console.error)
        .finally(() => setTaking((many) => many - 1));
      if (instrument) void keep(instrument, next).catch(console.error);
    }, REST);
  }

  if (!values) return null;

  return (
    <section className="flex flex-col gap-2" aria-busy={taking > 0}>
      <h3 className="text-[13px] font-semibold">
        Envelope
        {taking > 0 && (
          <span className="text-muted-ink ml-2 text-[11px] font-normal">
            going in, with about a second of silence
          </span>
        )}
      </h3>

      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <Knob
            id="envelope_attack"
            marked={marked}
            label="Attack"
            lo={0}
            hi={2000}
            value={Math.round(values.attack * 1000)}
            readout={seconds(values.attack)}
            onChange={(ms) => write({ ...values, attack: ms / 1000 })}
          />
          <Knob
            id="envelope_decay"
            marked={marked}
            label="Decay"
            lo={0}
            hi={4000}
            value={Math.round(values.decay * 1000)}
            readout={seconds(values.decay)}
            onChange={(ms) => write({ ...values, decay: ms / 1000 })}
          />
          <Knob
            id="envelope_sustain"
            marked={marked}
            label="Sustain"
            lo={0}
            hi={100}
            value={Math.round(values.sustain * 100)}
            readout={`${Math.round(values.sustain * 100)}%`}
            onChange={(percent) => write({ ...values, sustain: percent / 100 })}
          />
          <Knob
            id="envelope_release"
            marked={marked}
            label="Release"
            lo={0}
            hi={4000}
            value={Math.round(values.release * 1000)}
            readout={seconds(values.release)}
            onChange={(ms) => write({ ...values, release: ms / 1000 })}
          />
        </div>
        <EnvelopePlot envelope={values} sounding={sounding} />
      </div>
    </section>
  );
}

/** Two figures is as fine as the sliders go, and short enough for the readout column. */
function seconds(value: number): string {
  return `${value.toFixed(2)}s`;
}

/** Merges one instrument's envelope into the map the whole set is kept in. */
async function keep(instrument: string, envelope: Envelope): Promise<void> {
  const all = await getSettingOr('instrument_envelopes');
  await setSetting('instrument_envelopes', { ...all, [instrument]: envelope });
}

/** Seconds of held note the plot draws between the decay and the release. */
const HOLD = 0.3;
/** So that an envelope of nothing but zeroes still has an axis to be drawn against. */
const SHORTEST = 0.05;

/** The four corners the envelope is drawn through, in seconds across and loudness up. */
function cornersOf({ attack, decay, sustain, release }: Envelope): { at: number; level: number }[] {
  return [
    { at: 0, level: 0 },
    { at: attack, level: 1 },
    { at: attack + decay, level: sustain },
    { at: attack + decay + HOLD, level: sustain },
    { at: attack + decay + HOLD + release, level: 0 },
  ];
}

/** How loud a key that has been down this many seconds is, before it comes up. */
function levelAt(at: number, { attack, decay, sustain }: Envelope): number {
  if (at < attack) return attack > 0 ? at / attack : 1;
  if (at < attack + decay) return 1 - (1 - sustain) * (decay > 0 ? (at - attack) / decay : 1);
  return sustain;
}

/**
 * Where along the envelope one key has got to, or null once it has died away. A key still down
 * walks the attack and the decay and then rests where the drawn sustain ends. A key that has come
 * up lets go from wherever it had reached, so one dropped during the attack falls from there
 * rather than from a sustain it never got to.
 */
export function travelled(
  key: Sounding,
  envelope: Envelope,
  now: number,
): { at: number; level: number } | null {
  const rest = envelope.attack + envelope.decay + HOLD;
  const since = (now - key.at) / 1000;
  if (key.on) {
    const at = Math.min(since, rest);
    return { at, level: levelAt(at, envelope) };
  }
  if (since >= envelope.release) return null;
  const gone = envelope.release > 0 ? since / envelope.release : 1;
  return {
    at: rest + since,
    level: levelAt(Math.min(key.held / 1000, rest), envelope) * (1 - gone),
  };
}

/**
 * The envelope, small, beside the sliders that shape it: time across, loudness up, the whole of it
 * fitted to the box so that the shape stays readable however long or short it is set. Every key
 * under the hands walks the same line, in its own pitch colour, so a chord reads as a chord.
 */
function EnvelopePlot({ envelope, sounding }: { envelope: Envelope; sounding: Sounding[] }) {
  const dark = useDark();
  const corners = cornersOf(envelope);
  const span = Math.max(corners[corners.length - 1]!.at, SHORTEST);
  // Inset, so the dot at either end is drawn whole rather than half outside the box.
  const inset = (part: number) => 8 + part * 84;
  const across = (at: number) => inset(at / span);
  const up = (level: number) => inset(1 - level);
  const path = corners.map((one) => `${across(one.at).toFixed(1)},${up(one.level).toFixed(1)}`);

  const now = useMoving(sounding, envelope);

  return (
    <svg
      viewBox="0 0 100 100"
      role="img"
      aria-label="The envelope over time, with every key under the hands marked"
      className="border-edge-soft size-[68px] flex-none border"
    >
      <polyline
        points={path.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
      {sounding.map((note) => {
        const head = travelled(note, envelope, now);
        if (!head) return null;
        return (
          <circle
            key={note.midi}
            data-head={note.midi}
            cx={across(head.at)}
            cy={up(head.level)}
            r={7}
            fill={colorOf(note.midi, 'full', dark)}
          />
        );
      })}
    </svg>
  );
}

/**
 * The clock the dots are drawn against, ticking only while at least one of them still has
 * somewhere to go. A key resting at the sustain and a key that has died away both stop it, so an
 * open panel with hands off the keyboard costs nothing.
 */
function useMoving(sounding: Sounding[], envelope: Envelope): number {
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const at = performance.now();
      setNow(at);
      const rest = envelope.attack + envelope.decay + HOLD;
      const moving = sounding.some((key) =>
        key.on ? (at - key.at) / 1000 < rest : (at - key.at) / 1000 < envelope.release,
      );
      if (moving) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [sounding, envelope]);

  return now;
}
