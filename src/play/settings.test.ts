import { stepTempo } from '@/play/settings';
import { describe, expect, test } from 'vitest';

describe('the tempo one key press away', () => {
  test('lands on the next multiple of 5 in the direction', () => {
    expect(stepTempo(52, 1, false, 'percent')).toBe(55);
    expect(stepTempo(52, -1, false, 'percent')).toBe(50);
  });

  test('leaves a multiple of 5 for the next one, never standing still', () => {
    expect(stepTempo(55, 1, false, 'percent')).toBe(60);
    expect(stepTempo(55, -1, false, 'percent')).toBe(50);
  });

  test('moves by 1 when fine', () => {
    expect(stepTempo(52, 1, true, 'percent')).toBe(53);
    expect(stepTempo(52, -1, true, 'percent')).toBe(51);
  });

  test('stops at the ends of the mode range', () => {
    expect(stepTempo(198, 1, false, 'percent')).toBe(200);
    expect(stepTempo(25, -1, false, 'percent')).toBe(25);
    expect(stepTempo(238, 1, false, 'bpm')).toBe(240);
    expect(stepTempo(40, -1, true, 'bpm')).toBe(40);
  });

  test('reads the BPM number in BPM mode', () => {
    expect(stepTempo(72, 1, false, 'bpm')).toBe(75);
    expect(stepTempo(72, -1, false, 'bpm')).toBe(70);
  });
});
