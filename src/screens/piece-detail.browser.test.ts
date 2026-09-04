import { expect, test } from 'vitest';
import { tempoText } from './piece-detail';

test('a piece of one tempo reads as its number alone', () => {
  expect(tempoText({ has_tempo: 1, constant_tempo: 1, tempo_bpm: 72 })).toBe('♩ = 72');
});

test('a piece whose tempo changes reads as its first number and that it varies', () => {
  expect(tempoText({ has_tempo: 1, constant_tempo: 0, tempo_bpm: 71.6 })).toBe('♩ = 72, varies');
});

test('a piece whose file names no tempo says so, and one never indexed reads as nothing', () => {
  expect(tempoText({ has_tempo: 0, constant_tempo: 1, tempo_bpm: null })).toBe('no tempo mark');
  expect(tempoText({ has_tempo: null, constant_tempo: null, tempo_bpm: null })).toBeNull();
});
