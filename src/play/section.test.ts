import { sectionLabel } from '@/play/section';
import type { Measure } from '@/score/types';
import { describe, expect, test } from 'vitest';

/** Bars of one piece, printed from 1 as a piece with no pickup bar is. */
function measures(count: number): Measure[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    number: index + 1,
    startTick: index * 3840,
    durationTicks: 3840,
    beatsPerBar: 4,
    beatUnit: 4,
  }));
}

describe('the loop control label', () => {
  test('names the printed bar numbers of the Section', () => {
    expect(sectionLabel(measures(12), { from: 8, to: 11 })).toBe('Loop bars 9-12');
  });

  test('says one bar in the singular', () => {
    expect(sectionLabel(measures(12), { from: 8, to: 8 })).toBe('Loop bar 9');
  });

  test('is the bare control with no Section', () => {
    expect(sectionLabel(measures(4), null)).toBe('Loop');
  });
});
