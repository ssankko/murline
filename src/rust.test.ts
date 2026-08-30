import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { DEFAULT_ANSWERS } from '@/rust.fake';

/** The command names inside `generate_handler!`, without the module each one lives in. */
function registered(): string[] {
  const source = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const list = /generate_handler!\[([^\]]*)\]/.exec(source)?.[1] ?? '';
  return list
    .split(',')
    .map((name) => name.trim().split('::').pop() ?? '')
    .filter(Boolean)
    .sort();
}

test('the commands named here are the ones the Rust side registers', () => {
  expect(Object.keys(DEFAULT_ANSWERS).sort()).toEqual(registered());
});
