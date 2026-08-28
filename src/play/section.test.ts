import { savedSection, sectionLabel } from '@/play/section';
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

describe('the Section a piece reopens in', () => {
  test('is the range that was saved while the file still has its bars', () => {
    expect(savedSection(measures(20), 11, 15)).toEqual({ from: 11, to: 15 });
  });

  test('is nothing when the piece was never given one', () => {
    expect(savedSection(measures(20), null, null)).toBe(null);
  });

  test('keeps a Section on the pickup bar, which is index 0', () => {
    expect(savedSection(measures(20), 0, 0)).toEqual({ from: 0, to: 0 });
  });

  test('keeps a Section ending on the last bar of the piece', () => {
    expect(savedSection(measures(20), 18, 19)).toEqual({ from: 18, to: 19 });
  });

  test('is dropped when the file lost the bars it named, rather than seeking nowhere', () => {
    expect(savedSection(measures(12), 11, 15)).toBe(null);
    expect(savedSection(measures(0), 0, 0)).toBe(null);
  });

  test('is dropped when only one end was ever stored', () => {
    expect(savedSection(measures(20), 11, null)).toBe(null);
    expect(savedSection(measures(20), null, 15)).toBe(null);
  });

  test('is dropped when the stored ends are the wrong way round or off the front', () => {
    expect(savedSection(measures(20), 15, 11)).toBe(null);
    expect(savedSection(measures(20), -1, 4)).toBe(null);
  });
});

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
