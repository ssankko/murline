import { click, setClickVolume } from '@/play/click';
import { invoke } from '@tauri-apps/api/core';
import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

beforeEach(() => {
  vi.mocked(invoke).mockClear();
  setClickVolume(70);
});

test('one owed beat is one call of the click command, carrying its strength and the volume', () => {
  click('strong');
  click('weak');
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['audio_click', { strength: 'strong', volume: 70 }],
    ['audio_click', { strength: 'weak', volume: 70 }],
  ]);
});

test('volume 0 asks the engine for nothing', () => {
  setClickVolume(0);
  click('strong');
  expect(invoke).not.toHaveBeenCalled();
});

test('a volume outside the setting range is pulled back into it', () => {
  setClickVolume(140);
  click('weak');
  expect(invoke).toHaveBeenCalledWith('audio_click', { strength: 'weak', volume: 100 });
});
