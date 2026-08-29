import { describe, expect, test } from 'vitest';
import { keyOf, modeName, modeOf } from './key';

const C_MAJOR = keyOf(0, 0);
const A_MINOR = keyOf(0, 1);
const D_MAJOR = keyOf(2, 0);

describe('the degree form', () => {
  test('reads the major scale by number and everything else with a sign', () => {
    expect(C_MAJOR.degreeOf(0, 0)).toBe('1');
    expect(C_MAJOR.degreeOf(7, 0)).toBe('5');
    expect(C_MAJOR.degreeOf(10, 0)).toBe('♭7');
    expect(C_MAJOR.degreeOf(3, 0)).toBe('♭3');
    // The same pitch class is the raised fourth or the flat fifth by how the note is written.
    expect(C_MAJOR.degreeOf(6, 1)).toBe('♯4');
    expect(C_MAJOR.degreeOf(6, -1)).toBe('♭5');
  });

  test('reads a minor key against the harmonic minor scale', () => {
    expect(A_MINOR.degreeOf(9, 0)).toBe('1');
    expect(A_MINOR.degreeOf(0, 0)).toBe('3');
    expect(A_MINOR.degreeOf(8, 0)).toBe('7');
    // The subtonic is a flat seventh; the raised sixth of the melodic minor is a sharp sixth.
    expect(A_MINOR.degreeOf(7, 0)).toBe('♭7');
    expect(A_MINOR.degreeOf(6, 0)).toBe('♯6');
  });
});

describe('the scale and the name of a key', () => {
  test('is one object per signature and mode', () => {
    expect(keyOf(2, 0)).toBe(D_MAJOR);
    expect(keyOf(2, 1)).not.toBe(D_MAJOR);
  });

  test('holds the seven pitch classes of the key, from its tonic', () => {
    expect(C_MAJOR.pcs).toEqual([0, 2, 4, 5, 7, 9, 11]);
    expect(A_MINOR.pcs).toEqual([9, 11, 0, 2, 4, 5, 8]);
    expect(A_MINOR.tonic).toBe(9);
    expect(A_MINOR.has(8)).toBe(true);
    expect(A_MINOR.has(7)).toBe(false);
  });

  test('names every key of the circle, spelled by letter', () => {
    const named = (mode: number) => [...Array(15).keys()].map((i) => keyOf(i - 7, mode).name);
    expect(named(0)).toEqual([
      'C♭ major',
      'G♭ major',
      'D♭ major',
      'A♭ major',
      'E♭ major',
      'B♭ major',
      'F major',
      'C major',
      'G major',
      'D major',
      'A major',
      'E major',
      'B major',
      'F♯ major',
      'C♯ major',
    ]);
    expect(named(1)).toEqual([
      'A♭ minor',
      'E♭ minor',
      'B♭ minor',
      'F minor',
      'C minor',
      'G minor',
      'D minor',
      'A minor',
      'E minor',
      'B minor',
      'F♯ minor',
      'C♯ minor',
      'G♯ minor',
      'D♯ minor',
      'A♯ minor',
    ]);
  });

  test('lays a major key out one entry per scale degree', () => {
    expect(D_MAJOR.table).toEqual([
      {
        degree: 1,
        note: 'D',
        pitch: 2,
        role: 'tonic',
        triad: 'D',
        notes: 'D F♯ A',
        seventh: 'DM7',
      },
      {
        degree: 2,
        note: 'E',
        pitch: 4,
        role: 'supertonic',
        triad: 'Em',
        notes: 'E G B',
        seventh: 'Em7',
      },
      {
        degree: 3,
        note: 'F♯',
        pitch: 6,
        role: 'mediant',
        triad: 'F♯m',
        notes: 'F♯ A C♯',
        seventh: 'F♯m7',
      },
      {
        degree: 4,
        note: 'G',
        pitch: 7,
        role: 'subdominant',
        triad: 'G',
        notes: 'G B D',
        seventh: 'GM7',
      },
      {
        degree: 5,
        note: 'A',
        pitch: 9,
        role: 'dominant',
        triad: 'A',
        notes: 'A C♯ E',
        seventh: 'A7',
      },
      {
        degree: 6,
        note: 'B',
        pitch: 11,
        role: 'submediant',
        triad: 'Bm',
        notes: 'B D F♯',
        seventh: 'Bm7',
      },
      {
        degree: 7,
        note: 'C♯',
        pitch: 13,
        role: 'leading tone',
        triad: 'C♯°',
        notes: 'C♯ E G',
        seventh: 'C♯ø7',
      },
    ]);
  });

  test('stacks the harmonic minor, so its tonic and its mediant take a major seventh', () => {
    expect(A_MINOR.table.map((each) => each.triad)).toEqual([
      'Am',
      'B°',
      'C+',
      'Dm',
      'E',
      'F',
      'G♯°',
    ]);
    expect(A_MINOR.table.map((each) => each.seventh)).toEqual([
      'AmM7',
      'Bø7',
      'C+M7',
      'Dm7',
      'E7',
      'FM7',
      'G♯°7',
    ]);
    expect(A_MINOR.table.map((each) => each.notes)).toEqual([
      'A C E',
      'B D F',
      'C E G♯',
      'D F A',
      'E G♯ B',
      'F A C',
      'G♯ B D',
    ]);
  });

  test('spells one note per letter, so a deep signature keeps every letter once', () => {
    expect(keyOf(-7, 0).names).toEqual([
      'C♭',
      'D♭',
      'E♭',
      'F♭',
      'G♭',
      'A♭',
      'B♭',
    ]);
  });

  test('counts the signature and names the key that shares it', () => {
    expect(D_MAJOR.signature).toEqual({ count: 2, sign: '♯', notes: ['F♯', 'C♯'] });
    expect(keyOf(-3, 0).signature).toEqual({
      count: 3,
      sign: '♭',
      notes: ['B♭', 'E♭', 'A♭'],
    });
    expect(C_MAJOR.signature).toEqual({ count: 0, sign: '♯', notes: [] });
    expect(D_MAJOR.relative.name).toBe('B minor');
    expect(keyOf(-3, 0).relative.name).toBe('C minor');
    expect(C_MAJOR.relative.name).toBe('A minor');
    expect(A_MINOR.relative.name).toBe('C major');
  });

  test('names the key on the same tonic in the other mode', () => {
    expect(D_MAJOR.parallel).toBe(keyOf(-1, 1));
    expect(D_MAJOR.parallel.name).toBe('D minor');
    expect(A_MINOR.parallel).toBe(keyOf(3, 0));
    expect(A_MINOR.parallel.name).toBe('A major');
    expect(C_MAJOR.parallel).toBe(keyOf(-3, 1));
    expect(C_MAJOR.parallel.name).toBe('C minor');
  });
});

describe('the modes', () => {
  test('name every member of the KeyEnum and read the name back', () => {
    for (const mode of [0, 1, 3, 9]) expect(modeOf(modeName(mode))).toBe(mode);
    expect(modeName(3)).toBe('dorian');
    expect(keyOf(-1, 3).major).toBe(false);
    expect(keyOf(8, 0).major).toBe(true);
  });

  test('read anything unknown as major', () => {
    expect(modeName(42)).toBe('major');
    expect(modeOf('whatever')).toBe(0);
  });
});
