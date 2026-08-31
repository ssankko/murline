import { fakeRust, type FakeRust } from '@/rust.fake';
import { beforeEach, expect, test } from 'vitest';
import { scanLibrary } from './scan';

let rust: FakeRust;

beforeEach(() => {
  rust = fakeRust();
});

test('the folder is scanned once, and again only when the library points elsewhere', async () => {
  await scanLibrary('/scores');
  await scanLibrary('/scores');
  await scanLibrary('/other');
  await scanLibrary('/other');
  expect(rust.argsOf('index_plan')).toEqual([
    { folder: '/scores', path: null },
    { folder: '/other', path: null },
  ]);
});
