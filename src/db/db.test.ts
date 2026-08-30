import { beforeEach, expect, test, vi } from 'vitest';

let attempts = 0;
let failures = 0;
let rows: unknown[] = [];

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: async () => {
      attempts++;
      if (failures-- > 0) throw new Error('database is locked');
      return { select: async () => rows, execute: async () => {} };
    },
  },
}));

const { getDb } = await import('./db');

beforeEach(() => {
  attempts = 0;
  failures = 0;
});

test('an open that failed once is tried again on the next call', async () => {
  failures = 1;
  await expect(getDb()).rejects.toThrow('database is locked');
  await expect(getDb()).resolves.toBeDefined();
  expect(attempts).toBe(2);
});

test('an open that worked is shared, not repeated', async () => {
  const first = await getDb();
  expect(await getDb()).toBe(first);
  expect(attempts).toBe(0);
});
