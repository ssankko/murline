import { detectedRange, keyLayout, keyRange } from '@/lane/keyboard';
import { DEFAULT_PLAY_SETTINGS, type PlaySettings } from '@/play/settings';
import type { PlayNote } from '@/play/engine';
import { describe, expect, test } from 'vitest';

function notes(...spec: [number, PlayNote['hand']][]): PlayNote[] {
  return spec.map(([midi, hand]) => ({
    midi,
    tick: 0,
    durationTicks: 960,
    hand,
    grace: false,
    tiedFrom: false,
    measureIndex: 0,
    note: undefined as never,
  }));
}

function settings(over: Partial<PlaySettings> = {}): PlaySettings {
  return { ...DEFAULT_PLAY_SETTINGS, ...over };
}

describe('the keyboard range', () => {
  test('the piece preset pads the piece to whole octaves', () => {
    // D3 up to F5 fills C3 to B5.
    expect(keyRange(notes([50, 'left'], [77, 'right']), settings())).toEqual([48, 83]);
  });

  test('the piece preset spans both hands whatever the hands setting says', () => {
    const both = notes([40, 'left'], [72, 'right']);
    expect(keyRange(both, settings({ hands: 'right' }))).toEqual(
      keyRange(both, settings({ hands: 'both' })),
    );
  });

  test('a key-count preset ignores the piece', () => {
    expect(keyRange(notes([60, 'right']), settings({ keyboardPreset: 88 }))).toEqual([21, 108]);
  });
});

describe('the key layout', () => {
  test('white keys tile the width and black keys sit on the seam between them', () => {
    // One octave C to B: seven white keys of equal width.
    const layout = keyLayout(60, 71, 700);
    const white = layout.keys.filter((key) => !key.black);
    expect(white).toHaveLength(7);
    expect(white.map((key) => key.x)).toEqual([0, 100, 200, 300, 400, 500, 600]);

    const cSharp = layout.byMidi.get(61)!;
    expect(cSharp.w).toBeCloseTo(60, 6);
    expect(cSharp.x + cSharp.w / 2).toBeCloseTo(100, 6);
  });
});

describe('detectedRange', () => {
  test('takes the lower strike as the low end', () => {
    expect(detectedRange(36, 96)).toEqual([36, 96]);
  });

  test('takes the lower strike as the low end when it is struck second', () => {
    expect(detectedRange(96, 36)).toEqual([36, 96]);
  });

  test('answers one key struck twice with a range of that key', () => {
    expect(detectedRange(60, 60)).toEqual([60, 60]);
  });
});
