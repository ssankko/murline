// What the falling lane shows of a note beyond its place in time, and how much of the window it
// takes. All of it is global settings, so this file stands apart from the lane itself: the settings
// store reads the defaults here without pulling the canvas in with them.

/** Look knobs, all global settings the Look tab writes to. */
export type LaneHarmony = 'panels' | 'wheel' | 'off';

export interface LaneLook {
  lookaheadBeats: number;
  /** Width of a block as a percent of its key. */
  noteWidthPct: number;
  gapPx: number;
  keyLabels: boolean;
  /** How the harmony shows at the lane's top right: as the chord panels, as the wheel, or not at all. */
  harmony: LaneHarmony;
  /** Whether the keys outside the scale in force wear a ghosted face and a dotted border. */
  scaleMarks: boolean;
  /** Whether a block wears the pitch colour of its note, against one neutral ink for every note. */
  colour: boolean;
  /** Whether a block carries the name of its note, sharps and no octave, at its landing edge. */
  names: boolean;
}

export const DEFAULT_LANE_LOOK: LaneLook = {
  lookaheadBeats: 8,
  noteWidthPct: 80,
  gapPx: 2,
  keyLabels: true,
  harmony: 'panels',
  scaleMarks: false,
  colour: true,
  names: false,
};

/** Share of the window height the sheet takes by default; the beat scale is fixed against it. */
export const DEFAULT_SPLIT = 0.35;
export const SPLIT_MIN = 0.2;
export const SPLIT_MAX = 0.6;
