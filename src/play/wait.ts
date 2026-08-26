// Wait mode bookkeeping: what each Onset has collected so far and when that adds up to satisfied.
// The engine owns the clock, the windows and which Onset a strike belongs to; this owns only the
// counted strikes. Steps are indices into `Score.playOrder`, so a repeated bar counts afresh.

export class WaitState {
  /** Steps already satisfied. A satisfied Onset is never a stop and takes no more strikes. */
  private readonly done = new Set<number>();
  /** Per step, the held keys whose strike counted for it, at the strike's wall-clock time. */
  private readonly counted = new Map<number, Map<number, number>>();

  /** Forgets everything, which is what a fresh start of motion asks for. */
  reset(): void {
    this.done.clear();
    this.counted.clear();
  }

  /** Unsatisfies every Onset from a step on: a pause rewind and a Section lap both stop there again. */
  forgetFrom(step: number): void {
    for (const i of this.done) if (i >= step) this.done.delete(i);
    for (const i of this.counted.keys()) if (i >= step) this.counted.delete(i);
  }

  satisfied(step: number): boolean {
    return this.done.has(step);
  }

  /** Takes a strike as counting for a step; striking the same pitch again renews its time. */
  count(step: number, midi: number, time: number): void {
    let keys = this.counted.get(step);
    if (!keys) this.counted.set(step, (keys = new Map()));
    keys.set(midi, time);
  }

  /** A key coming up counts for nothing any more, wherever it counted. */
  release(midi: number): void {
    for (const keys of this.counted.values()) keys.delete(midi);
  }

  /** The steps holding strikes that have not added up yet. */
  open(): number[] {
    return [...this.counted.keys()];
  }

  /**
   * The satisfaction rule: every required pitch is held from a strike that counted, the first and
   * last of those strikes are inside the togetherness window, and no blocking key is held. Only
   * required pitches are ever counted, so holding them all means the two sets are equal.
   */
  settle(step: number, required: number[], togethernessMs: number, blocked: boolean): boolean {
    const keys = this.counted.get(step);
    if (!keys || blocked) return false;
    for (const midi of required) if (!keys.has(midi)) return false;
    const times = [...keys.values()];
    if (Math.max(...times) - Math.min(...times) > togethernessMs) return false;
    this.done.add(step);
    this.counted.delete(step);
    return true;
  }
}
