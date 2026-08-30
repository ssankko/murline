// The pinch on a sheet's paper: a trackpad spread or squeeze, arriving as a wheel with ctrl held
// or as the WebKit gesture events, turned into a spacing percent. Nothing is drawn while the
// fingers move; the sheet hears the percent once, when they stop.

import { clamp } from '@/lib/utils';

/**
 * Range the time spacing may be pinched to, the same percents the settings slider writes. Under
 * 100 only the bars with slack tighten: the rest stand at their engraved minimum.
 */
export const SPACING_MIN = 80;
export const SPACING_MAX = 300;

/**
 * Paper a sheet spaced by time takes over the tightest measure's pixels per tick, as a percent. The
 * slack is what carries the notes of a crowded bar to their own time; a bar still too crowded for
 * the width it gets keeps VexFlow's packing. The whole sheet grows with the percent, and OSMD
 * breaks its one line into systems past 32767 px.
 */
export const DEFAULT_SPACING = 150;

/**
 * Per trackpad pixel a pinch reports, how much it scales the spacing: `exp(-deltaY * ZOOM_K)`. A
 * spread across the whole trackpad reports about seventy pixels, so it roughly doubles the paper.
 */
const ZOOM_K = 0.01;

/** The pinch is over once nothing has come in for this long, and what it settled on is drawn. */
const LOOK_MS = 300;

/** A pinch under way: where the fingers are, and the spacing percent they are heading to. */
export interface Pinch {
  x: number;
  y: number;
  spacing: number;
}

/** What a sheet gives the pinch: what it is drawn at, whether it can pinch, and what to tell. */
export interface PinchOptions {
  /** The spacing percent the sheet is drawn at. */
  spacing: () => number;
  /** Whether the sheet has a spacing to pinch: one spaced by its engraving stands still. */
  active: () => boolean;
  /** Every step of a live pinch, and `null` once it is over: the sheet shows what it is choosing. */
  moving: (pinch: Pinch | null) => void;
  /** The pinch settled on a spacing other than the drawn one: the sheet draws it and stores it. */
  onSettle: (spacing: number) => void;
}

/** The spacing a wheel step carries a pinch to, from the percent it compounds on. */
export function wheelSpacing(from: number, deltaY: number): number {
  return from * Math.exp(-deltaY * ZOOM_K);
}

/** The percent a pinch may land on: a whole number inside the range the slider writes. */
export function clampSpacing(percent: number): number {
  return clamp(Math.round(percent), SPACING_MIN, SPACING_MAX);
}

/** Listens for the pinch on one host and turns it into spacing percents for its sheet. */
export class SpacingPinch {
  private readonly options: PinchOptions;
  /** Spacing percent the newest pinch step asks for, which the render at the end of it carries. */
  private zoomTo = 0;
  /** The wait for the pinch to stop; a live pinch is one that has this timer standing. */
  private lookTimer = 0;
  /** Spacing the running WebKit gesture started from, zero while no gesture is running. */
  private gesturing = 0;
  /** Where the pointer last stood, which is where a pinch shows what it is choosing. */
  private pointer = { x: 0, y: 0 };
  /** Takes every listener this pinch put on the host off again. */
  private readonly listeners = new AbortController();

  constructor(host: HTMLElement, options: PinchOptions) {
    this.options = options;
    const { signal } = this.listeners;
    host.addEventListener('pointermove', (event) => this.pointAt(event), { signal });
    // A trackpad pinch reaches the page as a wheel with ctrl held, and spaces the sheet instead
    // of scrolling it.
    host.addEventListener(
      'wheel',
      (event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        this.pointAt(event);
        if (!this.gesturing) this.pinch(wheelSpacing(this.target, event.deltaY));
      },
      { passive: false, signal },
    );
    // WebKit answers a trackpad pinch with these rather than with the ctrl-wheel, and zooms the
    // whole page unless every one of them is refused. A running gesture owns the pinch, so
    // fingers reported both ways are only applied once.
    const gesture = (event: Event): void => {
      event.preventDefault();
      this.pointAt(event);
      const scale = (event as { scale?: number }).scale ?? 1;
      if (event.type === 'gesturestart') this.gesturing = this.target;
      else if (this.gesturing) {
        // WebKit drops and coalesces `gesturechange` freely; `gestureend` is the one event that
        // always arrives, and its scale carries the whole travel of the fingers.
        this.pinch(this.gesturing * scale);
        if (event.type === 'gestureend') {
          this.gesturing = 0;
          this.settle();
        }
      }
    };
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      host.addEventListener(type, gesture, { passive: false, signal });
    }
  }

  /** Takes the listeners off the host and drops a pinch still waiting to settle. */
  dispose(): void {
    this.listeners.abort();
    clearTimeout(this.lookTimer);
  }

  /** What a pinch step compounds on: the target a live pinch is heading to, or the drawn spacing. */
  private get target(): number {
    return this.lookTimer ? this.zoomTo : this.options.spacing();
  }

  /** Keeps where the pointer stands, from any event that carries a point of its own. */
  private pointAt(event: Event): void {
    const at = event as { clientX?: number; clientY?: number };
    if (at.clientX !== undefined && at.clientY !== undefined) {
      this.pointer = { x: at.clientX, y: at.clientY };
    }
  }

  /**
   * One step of a pinch on the paper: the spacing the fingers ask for. A sheet spaced by its
   * engraving has no spacing to pinch and stands still. Nothing is drawn while the fingers move,
   * only the target and what the screen shows of it; `settle` hands the sheet the end of it.
   */
  private pinch(percent: number): void {
    if (!this.options.active()) return;
    this.zoomTo = clampSpacing(percent);
    this.options.moving({ ...this.pointer, spacing: this.zoomTo });
    clearTimeout(this.lookTimer);
    this.lookTimer = window.setTimeout(() => this.settle(), LOOK_MS);
  }

  /**
   * The end of a pinch: the spacing the fingers settled on goes to the sheet for its one render
   * of the whole gesture. Rendering the sheet takes hundreds of milliseconds and blocks the main
   * thread, so a render between two steps would eat the events that follow it.
   */
  private settle(): void {
    if (!this.lookTimer) return;
    clearTimeout(this.lookTimer);
    this.lookTimer = 0;
    if (this.zoomTo !== this.options.spacing()) this.options.onSettle(this.zoomTo);
    this.options.moving(null);
  }
}
