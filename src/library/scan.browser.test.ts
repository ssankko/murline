import { fakeRust, type FakeRust } from '@/rust.fake';
import { beforeEach, expect, test, vi } from 'vitest';
import { scanLibrary } from './scan';

let rust: FakeRust;

vi.mock('./queries', () => ({
  knownFiles: async () => [],
  markError: async () => {},
  setPresent: async () => {},
  upsertIndex: async () => {},
}));

beforeEach(() => {
  rust = fakeRust();
});

test('the folder is walked once, and again only when the library points elsewhere', async () => {
  await scanLibrary('/scores');
  await scanLibrary('/scores');
  await scanLibrary('/other');
  await scanLibrary('/other');
  expect(rust.argsOf('list_library')).toEqual([{ folder: '/scores' }, { folder: '/other' }]);
});
