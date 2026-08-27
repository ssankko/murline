import { clampSection, sectionLabel } from '@/play/section';
import type { Measure } from '@/score/types';
import { describe, expect, test } from 'vitest';

/** Bars numbered from `first`: a pickup bar is printed 0 and the bar after it is 1. */
function measures(count: number, first = 1): Measure[] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    number: first + index,
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

  test('reads a pickup bar as bar 0, so the bar after it is bar 1', () => {
    expect(sectionLabel(measures(4, 0), { from: 0, to: 1 })).toBe('Loop bars 0-1');
  });

  test('is the bare control with no Section', () => {
    expect(sectionLabel(measures(4), null)).toBe('Loop');
  });

  test('names the bars a Section is clamped to', () => {
    const bars = measures(4);
    expect(sectionLabel(bars, clampSection(bars, { from: 9, to: -2 }))).toBe('Loop bars 1-4');
  });
});
