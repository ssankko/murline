import { TICKS_PER_QUARTER, type Measure } from '@/score/types';
import { describe, expect, test } from 'vitest';
import { beatOf } from './beat';

function measure(beatsPerBar: number, beatUnit: number): Measure {
  return { index: 0, number: 1, startTick: 0, durationTicks: 0, beatsPerBar, beatUnit };
}

describe('the beat of a bar', () => {
  test('a simple meter beats in its own unit', () => {
    expect(beatOf(measure(4, 4))).toEqual({ ticks: TICKS_PER_QUARTER, perBar: 4 });
    expect(beatOf(measure(3, 4))).toEqual({ ticks: TICKS_PER_QUARTER, perBar: 3 });
  });

  test('a compound meter beats in dotted quarters', () => {
    expect(beatOf(measure(6, 8))).toEqual({ ticks: 1.5 * TICKS_PER_QUARTER, perBar: 2 });
    expect(beatOf(measure(12, 8))).toEqual({ ticks: 1.5 * TICKS_PER_QUARTER, perBar: 4 });
  });

  test('3/8 is too short to be compound and beats in eighths', () => {
    expect(beatOf(measure(3, 8))).toEqual({ ticks: TICKS_PER_QUARTER / 2, perBar: 3 });
  });
});
