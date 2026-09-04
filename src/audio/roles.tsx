// The Sound tab's Roles section: the noises a sampled piano makes around its tone, each one at a
// level of its own. The engine names the roles the loaded instrument offers; an instrument that
// offers none, such as a plugin or a plain file, gets no section at all.
//
// The setting holds the levels the user has moved, so an instrument nobody has touched plays
// everything it has whole. It is the engine's to read: a load puts the kept levels on by itself,
// so this section only shows and moves them.

import { Slider } from '@/look/rows';
import { set, setting } from '@/settings/settings';
import { type SettingRowId } from '@/settings/rows';
import { sticky } from '@/lib/utils';
import { commands, type Role } from '@/bindings';
import { useEffect, useState } from 'react';

/** What a role is the sound of, where its label does not already say. */
const HINTS: Partial<Record<Role, string>> = {
  release: 'The damper falling as a key comes up.',
  key_off: 'The key itself coming back up.',
  sympathetic: 'Other strings ringing along while the pedal is down.',
};

/** The level per role, 0 to 100; a role the map misses sounds at 100. */
type Levels = Partial<Record<Role, number>>;

/** What one instrument is kept at. A value written as the list of roles switched off reads as
 * those roles at 0, which is the same instrument playing the same way. */
function keptLevels(instrument: string | null): Levels {
  if (!instrument) return {};
  const kept: Levels | Role[] | undefined = setting('instrument_roles')[instrument];
  if (Array.isArray(kept)) return Object.fromEntries(kept.map((one) => [one, 0]));
  return kept ?? {};
}

const at = (levels: Levels, role: Role): number => levels[role] ?? 100;

/** The tone itself carries no level, so the engine never names it among the roles it offers. */
const rowOfRole = (role: Role): SettingRowId => `role_${role}` as SettingRowId;

/**
 * `roles` is what the loaded instrument offers, from the engine's status, and `round` goes up
 * whenever the instrument changed, which is when the sliders have new levels to show.
 */
export function RolesSection({
  roles = [],
  instrument,
  round = 0,
}: {
  roles?: Role[] | undefined;
  instrument?: string | null;
  round?: number;
}) {
  const [levels, setLevels] = useState<Levels>({});
  const offered = roles.join(' ');

  useEffect(() => {
    if (!roles.length) return;
    setLevels(keptLevels(instrument ?? null));
    // `offered` stands in for `roles`, which is a fresh array on every status the tab reads.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [instrument, round, offered]);

  /** Moves one role: the setting first, so a crash after it still plays what the user chose. */
  async function move(role: Role, percent: number): Promise<void> {
    const next = { ...levels, [role]: percent };
    setLevels(next);
    if (instrument) {
      await set('instrument_roles', { ...setting('instrument_roles'), [instrument]: next });
    }
    await commands.audioApplyRoleLevel(role, percent);
  }

  if (!roles.length) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Roles</h3>
      {roles.map((role) => (
        <Slider
          key={role}
          id={rowOfRole(role)}
          hint={HINTS[role]}
          min={0}
          max={100}
          value={at(levels, role)}
          readout={`${at(levels, role)}%`}
          onChange={(percent) => void move(role, sticky(percent)).catch(console.error)}
        />
      ))}
    </section>
  );
}
