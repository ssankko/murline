// The Preview's sheet: the whole piece as one endless vertical flow of systems, fitted to the
// width of its host. No cursor and no MIDI input; the one moving thing is the bar the playback
// stands in, which the Preview screen sets from the engine's progress.

import { clamp } from '@/lib/utils';
import { CURSOR, colorOf, tone } from '@/look/color';
import { buildScore } from '@/score/build';
import { loadInto } from '@/score/load';
import type { Score } from '@/score/types';
import { OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import { applyTheme, applyTiers, noteheadEl, paintHead } from './paint';

/** Host width that reads at zoom 1. A wider window grows the notation instead of the bar count. */
const BASE_WIDTH = 1000;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 1.5;

/** Width change small enough that a re-render would show nothing new. */
const SETTLED = 8;

/** Notation size for a host of this width. */
function zoomFor(width: number): number {
  return clamp(width / BASE_WIDTH, MIN_ZOOM, MAX_ZOOM);
}

/** A bar's place on the paper in pixels: the measure's own width, the whole height of its system. */
interface BarBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** One loaded Preview sheet: its OSMD instance, the Score behind it and the DOM it draws into. */
export class PreviewSheet {
  readonly osmd: OpenSheetMusicDisplay;
  score!: Score;

  /** Called with the measure index of the bar the reader clicked, which the screen seeks to. */
  onBar?: (measureIndex: number) => void;

  private readonly host: HTMLElement;
  /** The one element of the host this sheet owns: `dispose` takes it and everything in it away. */
  private readonly content: HTMLElement;
  /** OSMD draws in here. */
  private readonly paper: HTMLElement;
  /** The tint over the bar being played, out of the paper's own DOM so a render never wipes it. */
  private readonly tint: HTMLElement;
  private dark: boolean;
  private drawnWidth = 0;
  private boxes: BarBox[] = [];
  private bar: number | null = null;

  private constructor(host: HTMLElement, dark: boolean) {
    this.host = host;
    this.dark = dark;
    this.content = document.createElement('div');
    this.content.style.position = 'relative';
    host.append(this.content);
    this.paper = document.createElement('div');
    this.content.append(this.paper);
    this.tint = document.createElement('div');
    this.tint.className = 'preview-bar';
    this.tint.style.cssText = 'position:absolute;display:none;pointer-events:none;border-radius:3px';
    this.content.append(this.tint);
    this.content.addEventListener('click', (event) => this.clicked(event));
    this.osmd = new OpenSheetMusicDisplay(this.paper, {
      backend: 'svg',
      autoResize: false,
      // One page of unbounded height: the systems wrap down the window and never break to a page.
      pageFormat: 'Endless',
      drawCredits: true,
    });
    applyTheme(this.osmd, dark);
  }

  /** Loads the bytes, draws them at the host's width and builds the Score of what was drawn. */
  static async open(
    host: HTMLElement,
    bytes: Uint8Array,
    fileName: string,
    dark: boolean,
  ): Promise<PreviewSheet> {
    const sheet = new PreviewSheet(host, dark);
    await loadInto(sheet.osmd, bytes, fileName);
    sheet.draw();
    sheet.score = buildScore(sheet.osmd.Sheet);
    sheet.paint();
    return sheet;
  }

  /** Re-fits the sheet to the host, which a resize has made wider or narrower. */
  fit(): void {
    if (Math.abs(this.host.clientWidth - this.drawnWidth) < SETTLED) return;
    this.draw();
    this.paint();
  }

  /** Repaints the whole sheet for the other theme. */
  setDark(dark: boolean): void {
    this.dark = dark;
    applyTheme(this.osmd, dark);
    this.draw();
    this.paint();
  }

  /**
   * Highlights the bar the playback stands in and keeps it in view; null takes the tint away. A
   * bar already highlighted is left alone, so the scroll only moves when the playback does.
   */
  setBar(measureIndex: number | null): void {
    if (measureIndex === this.bar) return;
    this.bar = measureIndex;
    this.place();
    if (this.tint.style.display !== 'none') {
      this.tint.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  dispose(): void {
    this.osmd.clear();
    this.content.remove();
  }

  private draw(): void {
    this.drawnWidth = this.host.clientWidth;
    this.osmd.zoom = zoomFor(this.drawnWidth);
    this.osmd.render();
    this.locate();
    this.place();
  }

  /** Where every bar landed in the render just drawn. */
  private locate(): void {
    const unit = 10 * this.osmd.zoom;
    this.boxes = [];
    this.osmd.GraphicSheet.MeasureList.forEach((staves, index) => {
      const measure = staves.find((each) => each);
      const system = measure?.ParentMusicSystem;
      if (!measure || !system) return;
      const box = measure.PositionAndShape;
      // Both staves and the space between them: the tint marks the bar, not one hand's line.
      const frame = system.PositionAndShape;
      this.boxes[index] = {
        left: (box.AbsolutePosition.x + box.BorderLeft) * unit,
        top: (frame.AbsolutePosition.y + frame.BorderTop) * unit,
        width: (box.BorderRight - box.BorderLeft) * unit,
        height: (frame.BorderBottom - frame.BorderTop) * unit,
      };
    });
  }

  /** Writes the tint over the current bar, wherever the last render put it. */
  private place(): void {
    const box = this.bar === null ? undefined : this.boxes[this.bar];
    if (!box) {
      this.tint.style.display = 'none';
      return;
    }
    this.tint.style.display = 'block';
    this.tint.style.left = `${box.left}px`;
    this.tint.style.top = `${box.top}px`;
    this.tint.style.width = `${box.width}px`;
    this.tint.style.height = `${box.height}px`;
    this.tint.style.background = `color-mix(in srgb, ${tone(CURSOR, this.dark)} 20%, transparent)`;
  }

  private clicked(event: MouseEvent): void {
    if (!this.onBar) return;
    const rect = this.content.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const index = this.boxes.findIndex(
      (box) =>
        box &&
        x >= box.left &&
        x <= box.left + box.width &&
        y >= box.top &&
        y <= box.top + box.height,
    );
    if (index >= 0) this.onBar(index);
  }

  /** The pitch colour on every notehead of both staves, then the duration marks. */
  private paint(): void {
    for (const onset of this.score.onsets) {
      for (const note of onset.notes) {
        const head = noteheadEl(this.osmd, note.source);
        if (!head) continue;
        const colour = colorOf(note.midi, 'muted', this.dark);
        paintHead(head, { fill: colour, stroke: colour });
      }
    }
    applyTiers(this.host, this.dark);
  }
}
