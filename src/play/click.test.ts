import { Click } from '@/play/click';
import { fakeRust, type FakeRust } from '@/rust.fake';
import { beforeEach, expect, test } from 'vitest';

let rust: FakeRust;
let click: Click;

beforeEach(() => {
  rust = fakeRust();
  click = new Click();
});

test('one owed beat is one call of the click command, carrying its strength and the volume', () => {
  click.play('strong');
  click.play('weak');
  expect(rust.calls).toEqual([
    { name: 'audio_click', args: { strength: 'strong', volume: 70 } },
    { name: 'audio_click', args: { strength: 'weak', volume: 70 } },
  ]);
});

test('volume 0 asks the engine for nothing', () => {
  click.setVolume(0);
  click.play('strong');
  expect(rust.calls).toEqual([]);
});

test('a volume outside the setting range is pulled back into it', () => {
  click.setVolume(140);
  click.play('weak');
  expect(rust.argsOf('audio_click')).toEqual([{ strength: 'weak', volume: 100 }]);
});
