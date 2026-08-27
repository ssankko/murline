import { describe, expect, it } from 'vitest';
import type { PieceSettingRow } from '@/library/queries';
import { INHERITS_EVERYTHING, resolvePlaySettings, validNumber } from '@/play/resolve';
import { DEFAULT_PLAY_SETTINGS } from '@/play/settings';

const row = (own: Partial<PieceSettingRow> = {}): PieceSettingRow => ({
  ...INHERITS_EVERYTHING,
  ...own,
});

describe('resolvePlaySettings', () => {
  it('falls back to the built-in default when neither level answers', () => {
    const { settings, inherited } = resolvePlaySettings(row(), {});
    expect(settings).toEqual({
      tempoMode: 'percent',
      tempoValue: 100,
      metronome: false,
      countInBars: 1,
      hands: 'both',
      keyboardPreset: 'piece',
      keyboardLo: DEFAULT_PLAY_SETTINGS.keyboardLo,
      keyboardHi: DEFAULT_PLAY_SETTINGS.keyboardHi,
    });
    expect(Object.values(inherited).every(Boolean)).toBe(true);
  });

  it('takes the global default over the built-in one', () => {
    const { settings, inherited } = resolvePlaySettings(row(), {
      tempoValue: 80,
      hands: 'left',
      metronome: true,
    });
    expect(settings.tempoValue).toBe(80);
    expect(settings.hands).toBe('left');
    expect(settings.metronome).toBe(true);
    expect(inherited.tempoValue).toBe(true);
  });

  it('takes the piece over both', () => {
    const { settings, inherited } = resolvePlaySettings(
      row({ tempo_mode: 'bpm', tempo_value: 96, hands: 'right' }),
      { tempoValue: 80, hands: 'left' },
    );
    expect(settings.tempoMode).toBe('bpm');
    expect(settings.tempoValue).toBe(96);
    expect(settings.hands).toBe('right');
    expect(inherited.tempoValue).toBe(false);
    expect(inherited.hands).toBe(false);
    expect(inherited.metronome).toBe(true);
  });

  it('keeps a piece value of 0 or false instead of inheriting it', () => {
    const { settings, inherited } = resolvePlaySettings(row({ count_in_bars: 0, metronome: 0 }), {
      countInBars: 2,
      metronome: true,
    });
    expect(settings.countInBars).toBe(0);
    expect(settings.metronome).toBe(false);
    expect(inherited.countInBars).toBe(false);
    expect(inherited.metronome).toBe(false);
  });

  it('reads the keyboard preset back out of its column', () => {
    expect(resolvePlaySettings(row({ keyboard_preset: '61' }), {}).settings.keyboardPreset).toBe(61);
    expect(
      resolvePlaySettings(row({ keyboard_preset: 'custom', keyboard_lo: 40, keyboard_hi: 80 }), {})
        .settings,
    ).toMatchObject({ keyboardPreset: 'custom', keyboardLo: 40, keyboardHi: 80 });
  });

  it('ignores a column holding something it does not know', () => {
    const { settings, inherited } = resolvePlaySettings(
      row({ hands: 'feet', tempo_mode: 'swing', keyboard_preset: '37' }),
      { hands: 'left' },
    );
    expect(settings.hands).toBe('left');
    expect(settings.tempoMode).toBe('percent');
    expect(settings.keyboardPreset).toBe('piece');
    expect(inherited.hands).toBe(true);
  });
});

describe('validNumber', () => {
  it('takes a number inside the span', () => {
    expect(validNumber('0.7', 0, 1, 0.2)).toEqual({ value: 0.7, error: null });
  });

  it('keeps the last valid value for a weight outside 0 to 1', () => {
    expect(validNumber('2', 0, 1, 0.7)).toEqual({ value: 0.7, error: 'Enter a number from 0 to 1' });
  });

  it('keeps the last valid value for text that is no number at all', () => {
    expect(validNumber('loud', 0, 1, 0.7).value).toBe(0.7);
    expect(validNumber('', 0, 1, 0.7).error).not.toBe(null);
  });

  it('takes the edges of the span', () => {
    expect(validNumber('0', 0, 1, 0.7).error).toBe(null);
    expect(validNumber('1', 0, 1, 0.7).error).toBe(null);
  });
});
