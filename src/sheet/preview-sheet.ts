// The Preview's sheet: the whole piece as one endless vertical flow of systems, fitted to the
// width of its host. No cursor, no clock, no input; everything here happens at open, on a resize
// and on a theme change.

import { clamp } from '@/lib/utils';
import { colorOf } from '@/look/color';
import { buildScore } from '@/score/build';
import { ScoreError, type Score } from '@/score/types';
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

/** One loaded Preview sheet: its OSMD instance, the Score behind it and the DOM it draws into. */
export class PreviewSheet {
  readonly osmd: OpenSheetMusicDisplay;
  score!: Score;

  private readonly host: HTMLElement;
  private dark: boolean;
  private drawnWidth = 0;

  private constructor(host: HTMLElement, dark: boolean) {
    this.host = host;
    this.dark = dark;
    this.osmd = new OpenSheetMusicDisplay(host, {
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
    try {
      await sheet.osmd.load(new Blob([bytes as BlobPart]), fileName);
    } catch (error) {
      throw new ScoreError('Not a MusicXML file', String(error));
    }
    if (!sheet.osmd.Sheet) throw new ScoreError('Not a MusicXML file', 'the file holds no score');
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

  dispose(): void {
    this.osmd.clear();
  }

  private draw(): void {
    this.drawnWidth = this.host.clientWidth;
    this.osmd.zoom = zoomFor(this.drawnWidth);
    this.osmd.render();
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
