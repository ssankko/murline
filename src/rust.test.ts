import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { PIECE_SETTING_COLUMNS } from '@/library/queries';

test('the piece-setting columns are the ones the Rust side takes', () => {
  const source = readFileSync(new URL('../src-tauri/src/pieces.rs', import.meta.url), 'utf8');
  const list = /const SETTINGS[^=]*= \[([^\]]*)\]/.exec(source)?.[1] ?? '';
  const columns = [...list.matchAll(/"([^"]+)"/g)].map((hit) => hit[1]).sort();
  expect(Object.values(PIECE_SETTING_COLUMNS).sort()).toEqual(columns);
});
