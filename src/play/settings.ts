// The settings one play runs under. A piece setting falls back to the global one and a global one
// to the defaults here; that resolution happens where a play is started, never inside the engine.

export type TempoMode = 'percent' | 'bpm';

/** Flow runs the cursor at tempo whatever the player does; Wait stops it at every unsatisfied Onset. */
export type PlayMode = 'flow' | 'wait';

/** Which hand the play expects. The other hand's notes are context only. */
export type HandsSetting = 'both' | 'left' | 'right';

/** "piece" spans the piece's own range; a number is that many keys; "custom" uses lo and hi. */
export type KeyboardPreset = 'piece' | 25 | 49 | 61 | 76 | 88 | 'custom';

export interface PlaySettings {
  tempoMode: TempoMode;
  /** Percent of every written tempo mark (25 to 200), or a flat quarter-note BPM (40 to 240). */
  tempoValue: number;
  hands: HandsSetting;
  mode: PlayMode;
  metronome: boolean;
  /** Bars of count-in before every start of motion; 0 turns the count-in off. */
  countInBars: number;
  keyboardPreset: KeyboardPreset;
  keyboardLo: number;
  keyboardHi: number;
  /** Half-width of the span around an Onset in which a strike counts for it, in milliseconds. */
  matchingWindowMs: number;
  /** How far apart the first and last strike of one chord may be, in milliseconds. */
  togethernessMs: number;
}

export const DEFAULT_PLAY_SETTINGS: PlaySettings = {
  tempoMode: 'percent',
  tempoValue: 100,
  hands: 'both',
  mode: 'flow',
  metronome: false,
  countInBars: 1,
  keyboardPreset: 'piece',
  keyboardLo: 21,
  keyboardHi: 108,
  matchingWindowMs: 150,
  togethernessMs: 250,
};
