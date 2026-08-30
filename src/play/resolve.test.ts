import { describe, expect, it } from 'vitest';
import { SETTING_DEFAULTS } from '@/settings/settings';
import { PIECE_SETTING_COLUMNS, type PieceSettingRow } from '@/library/queries';
import { resolvePlaySettings, UNSET_PIECE_SETTINGS } from '@/play/resolve';

const row = (own: Partial<PieceSettingRow> = {}): PieceSettingRow => ({
  ...UNSET_PIECE_SETTINGS,
  ...own,
});

describe('resolvePlaySettings', () => {
  it('opens a piece never opened before at the built-in defaults', () => {
    expect(resolvePlaySettings(row())).toEqual({
      tempoMode: 'percent',
      tempoValue: 100,
      metronome: false,
      countInBars: 0,
      hands: 'both',
      mode: 'flow',
      loop: false,
      sectionFrom: null,
      sectionTo: null,
    });
  });

  it('takes the piece over the built-in default', () => {
    const settings = resolvePlaySettings(
      row({
        tempo_mode: 'bpm',
        tempo_value: 96,
        hands: 'right',
        metronome: 1,
        count_in_bars: 1,
        mode: 'wait',
        loop: 1,
        section_from: 11,
        section_to: 15,
      }),
    );
    expect(settings).toEqual({
      tempoMode: 'bpm',
      tempoValue: 96,
      metronome: true,
      countInBars: 1,
      hands: 'right',
      mode: 'wait',
      loop: true,
      sectionFrom: 11,
      sectionTo: 15,
    });
  });

  it('keeps a piece value of 0 or false instead of falling through', () => {
    const settings = resolvePlaySettings(row({ count_in_bars: 0, metronome: 0, loop: 0 }));
    expect(settings.countInBars).toBe(0);
    expect(settings.metronome).toBe(false);
    // Loop is the one where it bites: a stored 0 is Loop turned off, not Loop never set.
    expect(settings.loop).toBe(false);
  });

  it('keeps a Section starting at the pickup bar, which is index 0', () => {
    const settings = resolvePlaySettings(row({ section_from: 0, section_to: 0 }));
    expect(settings.sectionFrom).toBe(0);
    expect(settings.sectionTo).toBe(0);
  });

  it('ignores a column holding something it does not know', () => {
    const settings = resolvePlaySettings(row({ hands: 'feet', tempo_mode: 'swing', mode: 'jog' }));
    expect(settings.hands).toBe('both');
    expect(settings.tempoMode).toBe('percent');
    expect(settings.mode).toBe('flow');
  });
});

describe('no piece setting has a global default', () => {
  it('leaves no default_ setting for a piece to fall back to', () => {
    expect(Object.keys(SETTING_DEFAULTS).filter((key) => key.startsWith('default_'))).toEqual([]);
  });

  it('keeps the keyboard size out of the piece, so one choice applies everywhere', () => {
    expect(Object.keys(PIECE_SETTING_COLUMNS)).toEqual([
      'tempoMode',
      'tempoValue',
      'metronome',
      'countInBars',
      'hands',
      'mode',
      'loop',
      'sectionFrom',
      'sectionTo',
    ]);
    expect(SETTING_DEFAULTS.keyboard_preset).toBe('piece');
  });
});
