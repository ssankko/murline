import { expect, test } from 'vitest';
import { planScan, type FileEntry } from './scan';
import type { KnownFile } from './queries';

const file = (path: string, mtime = 100, size = 10): FileEntry => ({
  relPath: path,
  mtime,
  size,
});
const row = (path: string, mtime = 100, size = 10, present = 1): KnownFile => ({
  path,
  mtime,
  size,
  present,
});

test('a file the database has never seen is indexed', () => {
  expect(planScan([file('bach.musicxml')], [])).toEqual([
    { kind: 'index', file: file('bach.musicxml') },
  ]);
});

test('a file that matches its row is left alone', () => {
  expect(planScan([file('bach.musicxml')], [row('bach.musicxml')])).toEqual([]);
});

test('a file whose mtime or size moved is indexed again', () => {
  expect(planScan([file('bach.musicxml', 200)], [row('bach.musicxml', 100)])).toEqual([
    { kind: 'index', file: file('bach.musicxml', 200) },
  ]);
  expect(planScan([file('bach.musicxml', 100, 20)], [row('bach.musicxml', 100, 10)])).toEqual([
    { kind: 'index', file: file('bach.musicxml', 100, 20) },
  ]);
});

test('a row whose file is gone is hidden, once', () => {
  expect(planScan([], [row('bach.musicxml')])).toEqual([{ kind: 'hide', path: 'bach.musicxml' }]);
  expect(planScan([], [row('bach.musicxml', 100, 10, 0)])).toEqual([]);
});

test('the same file back untouched is restored without a reindex', () => {
  expect(planScan([file('bach.musicxml')], [row('bach.musicxml', 100, 10, 0)])).toEqual([
    { kind: 'restore', path: 'bach.musicxml' },
  ]);
});

test('a file back in a new shape is indexed rather than restored', () => {
  expect(planScan([file('bach.musicxml', 300)], [row('bach.musicxml', 100, 10, 0)])).toEqual([
    { kind: 'index', file: file('bach.musicxml', 300) },
  ]);
});

test('subfolders are just longer paths', () => {
  const files = [file('romantic/schumann.mxl'), file('schumann.mxl')];
  expect(planScan(files, [row('schumann.mxl')])).toEqual([
    { kind: 'index', file: file('romantic/schumann.mxl') },
  ]);
});
