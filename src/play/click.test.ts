import { click, setClickVolume } from '@/play/click';
import { fakeRust, type FakeRust } from '@/rust.fake';
import { beforeEach, expect, test } from 'vitest';

let rust: FakeRust;

beforeEach(() => {
  rust = fakeRust();
  setClickVolume(70);
});

test('one owed beat is one call of the click command, carrying its strength and the volume', () => {
  click('strong');
  click('weak');
  expect(rust.calls).toEqual([
    { name: 'audio_click', args: { strength: 'strong', volume: 70 } },
    { name: 'audio_click', args: { strength: 'weak', volume: 70 } },
  ]);
});

test('volume 0 asks the engine for nothing', () => {
  setClickVolume(0);
  click('strong');
  expect(rust.calls).toEqual([]);
});

test('a volume outside the setting range is pulled back into it', () => {
  setClickVolume(140);
  click('weak');
  expect(rust.argsOf('audio_click')).toEqual([{ strength: 'weak', volume: 100 }]);
});
