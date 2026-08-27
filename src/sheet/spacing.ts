// Note positions written by time rather than by engraving. VexFlow packs a notehead, its
// accidentals and any second-voice displacement into a minimum of paper and spreads only what a bar
// has over that packing, so inside a bar every note keeps a speed of its own. This moves each of a
// bar's tick contexts to its share of the bar's duration, which VexFlow then draws stems, beams,
// ties and ledger lines from, and OSMD reads back for slurs and the skyline.

import { VexFlowMeasure } from 'opensheetmusicdisplay';

/** Paper VexFlow keeps between a stave's note start and the first notehead. */
const NOTE_PAD = 12;

/** Where one moment of a bar stands, and how much paper the notes beginning there pack into. */
interface TickContext {
  setX(x: number): void;
  getWidth(): number;
  tickables: Tickable[];
  /** Every tick context of the bar, one per moment a note begins, in no order. */
  tContexts: TickContext[];
}

interface Tickable {
  tickContext?: TickContext;
  voice?: Voice;
  getTicks(): { value(): number };
}

interface Voice {
  getTickables(): Tickable[];
}

interface Stave {
  getNoteStartX(): number;
  getNoteEndX(): number;
}

type Formatted = VexFlowMeasure & { vfVoices: Record<string, Voice>; getVFStave(): Stave };

/** The engraving rules of every sheet whose notes stand at their time. */
const timed = new WeakSet<object>();

/**
 * Says whether one sheet spaces its notes by time. The rules object stands for the sheet: it is the
 * one thing a measure holds that belongs to a single OSMD instance.
 */
export function setTimed(rules: object, on: boolean): void {
  patch();
  if (on) timed.add(rules);
  else timed.delete(rules);
}

let patched = false;

/**
 * Hangs the re-spacing on `format`, which OSMD calls once per bar with the bar's final width and
 * before it reads any position back. The patch is global to the OSMD build, so a sheet that spaces
 * by engraving passes through it untouched.
 */
function patch(): void {
  if (patched) return;
  patched = true;
  const format = VexFlowMeasure.prototype.format;
  VexFlowMeasure.prototype.format = function (this: VexFlowMeasure) {
    format.call(this);
    if (timed.has(this.rules)) respace(this as Formatted);
  };
}

/**
 * Moves every moment of one bar to its share of the bar's paper. A bar whose notes would then pack
 * closer than they print keeps VexFlow's own spacing: no width the sheet can hold would carry it.
 */
function respace(measure: Formatted): void {
  const stave = measure.getVFStave?.();
  if (!stave) return;
  const span = stave.getNoteEndX() - stave.getNoteStartX() - NOTE_PAD;
  const bar = moments(measure);
  if (!bar || span <= 0) return;
  const { order, total } = bar;
  for (const [i, [context, tick]] of order.entries()) {
    const next = order[i + 1]?.[1] ?? total;
    if (((next - tick) / total) * span < context.getWidth()) return;
  }
  for (const [context, tick] of order) context.setX((tick / total) * span);
}

/** Every moment of a bar with the tick it stands at, in time order, and the bar's own duration. */
function moments(measure: Formatted): { order: [TickContext, number][]; total: number } | null {
  const voices = new Set<Voice>(Object.values(measure.vfVoices));
  // A voice of the other staff is only reachable through the moments its notes stand at, which the
  // formatter shares with this staff's voices.
  const seed = [...voices][0]?.getTickables()[0]?.tickContext;
  for (const context of seed?.tContexts ?? []) {
    for (const tickable of context.tickables) if (tickable.voice) voices.add(tickable.voice);
  }
  const at = new Map<TickContext, number>();
  let total = 0;
  for (const voice of voices) {
    let tick = 0;
    for (const tickable of voice.getTickables()) {
      if (tickable.tickContext && !at.has(tickable.tickContext)) at.set(tickable.tickContext, tick);
      tick += tickable.getTicks().value();
    }
    total = Math.max(total, tick);
  }
  if (total <= 0 || at.size === 0) return null;
  return { order: [...at].sort((a, b) => a[1] - b[1]), total };
}
