import { beforeEach, expect, test, vi } from 'vitest';
import { scanLibrary } from './scan';

let listed: string[] = [];

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: Record<string, string>) => {
    if (command === 'list_library') {
      listed.push(args.folder!);
      return [];
    }
    throw new Error(`unexpected command ${command}`);
  },
}));

vi.mock('./queries', () => ({
  knownFiles: async () => [],
  markError: async () => {},
  setPresent: async () => {},
  upsertIndex: async () => {},
}));

beforeEach(() => {
  listed = [];
});

test('the folder is walked once, and again only when the library points elsewhere', async () => {
  await scanLibrary('/scores');
  await scanLibrary('/scores');
  await scanLibrary('/other');
  await scanLibrary('/other');
  expect(listed).toEqual(['/scores', '/other']);
});
