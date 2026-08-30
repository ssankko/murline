import { expect, test } from 'vitest';
import { reasonOf } from '@/library/notice';
import { progressLabel } from '@/library/pdmx';
import type { FinderRow } from '@/rust';
import { metaLine, titleLine } from './finder';

function row(fields: Partial<FinderRow>): FinderRow {
  return {
    provider: 'KernScores',
    heading: 'Frédéric Chopin',
    title: '',
    opus: null,
    number: null,
    movement: null,
    movementName: null,
    key: null,
    time: null,
    bars: null,
    ratings: 0,
    alt: null,
    file: '',
    fileName: '',
    ...fields,
  };
}

test('the opus and number join the title only when the title does not already spell them', () => {
  expect(titleLine(row({ title: 'Nocturne in E-flat major, Op. 9 No. 2', opus: '9', number: '2' })))
    .toBe('Nocturne in E-flat major, Op. 9 No. 2');
  expect(titleLine(row({ title: 'Piano Sonata no. 1 in F minor', opus: '2', number: '1' })))
    .toBe('Piano Sonata no. 1 in F minor, Op. 2 No. 1');
  expect(titleLine(row({ title: 'Sonata in D minor', opus: 'K. 141' })))
    .toBe('Sonata in D minor, K. 141');
});

test('a movement follows the title after a dot separator', () => {
  expect(
    titleLine(
      row({ title: 'Piano Sonata no. 1', opus: '2', number: '1', movement: 1, movementName: 'Allegro' }),
    ),
  ).toBe('Piano Sonata no. 1, Op. 2 No. 1 · 1. Allegro');
  expect(titleLine(row({ title: 'Prelude', movement: 3 }))).toBe('Prelude · 3.');
});

test('the grey line names key, time, bars and provider for a KernScores row', () => {
  expect(metaLine(row({ key: 'F minor', time: '2/2', bars: 152 })))
    .toBe('F minor · 2/2 · 152 bars · KernScores');
});

test('a PDMX row shows the uploader title, and only when it differs from the song name', () => {
  const pdmx = { provider: 'PDMX' as const, bars: 26, ratings: 3 };
  expect(metaLine(row({ ...pdmx, alt: 'Gymnopédie no. 1 - Erik Satie' })))
    .toBe('Gymnopédie no. 1 - Erik Satie · 26 bars · 3 ratings · PDMX');
  expect(metaLine(row(pdmx))).toBe('26 bars · 3 ratings · PDMX');
});

test('the failure reason drops the prefix a thrown Error carries', () => {
  expect(reasonOf(new Error('HTTP 404 from KernScores'))).toBe('HTTP 404 from KernScores');
});

test('the PDMX download reads its progress in the unit of the whole archive', () => {
  expect(progressLabel({ done: 812_000_000, total: 1_890_000_000 })).toBe('0.8 of 1.9 GB');
  expect(progressLabel({ done: 812_000_000, total: null })).toBe('812 MB');
});
