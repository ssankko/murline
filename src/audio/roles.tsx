// The Sound tab's Roles section: the noises a sampled piano makes around its tone, each one at a
// level of its own. The engine names the roles the loaded instrument offers; an instrument that
// offers none, such as a plugin or a plain file, gets no section at all.
//
// The setting holds the levels the user has moved, so an instrument nobody has touched plays
// everything it has whole. The engine puts every role back to 100 on a load, so the levels are
// sent again whenever the loaded instrument changes.

import { Knob } from '@/audio/knob';
import { getSettingOr, setSetting } from '@/db/db';
import { sticky } from '@/lib/utils';
import { call, type Role } from '@/rust';
import { useEffect, useState } from 'react';

/** What each role is called on screen, in the words a player would use for the sound. */
const LABELS: Record<Role, string> = {
  release: 'Release samples',
  key_off: 'Key-off noise',
  sympathetic: 'Sympathetic resonance',
  pedal_noise: 'Pedal noise',
};

/** What each role is the sound of, which is what tells the player which one to turn down. */
const HINTS: Record<Role, string> = {
  release: 'The damper falling as a key comes up.',
  key_off: 'The key itself coming back up.',
  sympathetic: 'Other strings ringing along, pedal down.',
  pedal_noise: 'The pedal moving, down or up.',
};

/** The level per role, 0 to 100; a role the map misses sounds at 100. */
type Levels = Partial<Record<Role, number>>;

/** What one instrument is kept at. A value written as the list of roles switched off reads as
 * those roles at 0, which is the same instrument playing the same way. */
async function keptLevels(instrument: string | null): Promise<Levels> {
  if (!instrument) return {};
  const kept: Levels | Role[] | undefined = (await getSettingOr('instrument_roles'))[instrument];
  if (Array.isArray(kept)) return Object.fromEntries(kept.map((one) => [one, 0]));
  return kept ?? {};
}

const at = (levels: Levels, role: Role): number => levels[role] ?? 100;

/** Sends every offered role's level to the engine, which loads with all of them at 100. */
async function send(roles: Role[], levels: Levels): Promise<void> {
  for (const role of roles) {
    await call('audio_set_role_level', { role, percent: at(levels, role) });
  }
}

/**
 * Puts the levels an instrument is kept at back on the engine. Reads the offered roles from the
 * engine, because only it knows what the file holds. An instrument with nothing moved already
 * plays as it should and is left alone.
 */
export async function restoreRoles(instrument: string | null): Promise<void> {
  const levels = await keptLevels(instrument);
  if (!Object.keys(levels).length) return;
  const { roles } = await call('audio_status');
  await send(roles, levels);
}

/**
 * `roles` is what the loaded instrument offers, from the engine's status, and `round` goes up
 * whenever the instrument changed, which is when the engine has forgotten the levels.
 */
export function RolesSection({
  marked,
  roles = [],
  instrument,
  round = 0,
}: {
  /** The row a search result jumped to, which each level row tints itself for. */
  marked?: string | null;
  roles?: Role[];
  instrument?: string | null;
  round?: number;
}) {
  const [levels, setLevels] = useState<Levels>({});
  const offered = roles.join(' ');

  useEffect(() => {
    if (!roles.length) return;
    let live = true;
    void (async () => {
      const kept = await keptLevels(instrument ?? null);
      if (!live) return;
      setLevels(kept);
      await send(roles, kept);
    })().catch(console.error);
    return () => {
      live = false;
    };
    // `offered` stands in for `roles`, which is a fresh array on every status the tab reads.
  }, [instrument, round, offered]);

  /** Moves one role: the setting first, so a crash after it still plays what the user chose. */
  async function move(role: Role, percent: number): Promise<void> {
    const next = { ...levels, [role]: percent };
    setLevels(next);
    if (instrument) {
      const all = await getSettingOr('instrument_roles');
      await setSetting('instrument_roles', { ...all, [instrument]: next });
    }
    await call('audio_set_role_level', { role, percent });
  }

  if (!roles.length) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Roles</h3>
      {roles.map((role) => (
        <Knob
          key={role}
          id={`role_${role}`}
          marked={marked}
          label={LABELS[role]}
          hint={HINTS[role]}
          lo={0}
          hi={100}
          value={at(levels, role)}
          readout={`${at(levels, role)}%`}
          onChange={(percent) => void move(role, sticky(percent)).catch(console.error)}
        />
      ))}
    </section>
  );
}
