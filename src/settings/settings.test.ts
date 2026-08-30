import { fakeRust, fakeSettings } from '@/rust.fake';
import { load, set, setting, SETTING_DEFAULTS, subscribe } from '@/settings/settings';
import { beforeEach, expect, test } from 'vitest';

beforeEach(async () => {
  fakeRust();
  await load();
});

test('a setting never written reads as its default', async () => {
  expect(setting('theme')).toBe('system');
  expect(setting('audio_voices')).toBe(SETTING_DEFAULTS.audio_voices);
});

test('a stored value of another type than its default is passed over', async () => {
  // A keyboard size is a name or a count of keys, so both types are its own.
  fakeSettings.set('keyboard_preset', 61);
  fakeSettings.set('lane_gap', 'wide');
  await load();
  expect(setting('keyboard_preset')).toBe(61);
  expect(setting('lane_gap')).toBe(SETTING_DEFAULTS.lane_gap);
});

test('a write is in memory before the Rust side has it, and tells whoever draws that key', async () => {
  const heard: number[] = [];
  const stop = subscribe('lane_gap', () => heard.push(setting('lane_gap')));

  const writing = set('lane_gap', 12);
  expect(setting('lane_gap')).toBe(12);
  expect(await writing).toBe('');
  expect(heard).toEqual([12]);
  expect(fakeSettings.get('lane_gap')).toBe(12);

  stop();
  await set('lane_gap', 3);
  expect(heard).toEqual([12]);
});

test('a value the Rust side refuses goes back to what it was, with the reason for the caller', async () => {
  fakeRust({
    settings_write: () => {
      throw '64 frames is not one of this device’s sizes';
    },
  });
  const heard: number[] = [];
  subscribe('audio_buffer_frames', () => heard.push(setting('audio_buffer_frames')));

  const reason = await set('audio_buffer_frames', 32);
  expect(reason).toBe('64 frames is not one of this device’s sizes');
  expect(setting('audio_buffer_frames')).toBe(SETTING_DEFAULTS.audio_buffer_frames);
  // The row saw the value it asked for and then saw it taken away again.
  expect(heard).toEqual([32, SETTING_DEFAULTS.audio_buffer_frames]);
});
