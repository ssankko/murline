// The Sound tab's Roles section: the noises a sampled piano makes around its tone, each one
// switchable on its own. The engine names the roles the loaded instrument offers; an instrument
// that offers none, such as a plugin or a plain file, gets no section at all.
//
// The setting holds the roles switched off, so an instrument nobody has touched plays everything
// it has. The engine has every role on after a load, so the set is put back whenever the loaded
// instrument changes.

import { getSettingOr, setSetting } from '@/db/db';
import { rowId } from '@/lib/utils';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

/** A part of an instrument other than the tone a key-down sounds. */
export type Role = 'release' | 'key_off' | 'sympathetic' | 'pedal_noise';

/** What each role is called on screen, in the words a player would use for the sound. */
const LABELS: Record<Role, string> = {
  release: 'Release samples',
  key_off: 'Key-off noise',
  sympathetic: 'Sympathetic resonance',
  pedal_noise: 'Pedal noise',
};

/** The roles kept switched off for one instrument. */
async function keptOff(instrument: string | null): Promise<Role[]> {
  if (!instrument) return [];
  return (await getSettingOr('instrument_roles'))[instrument] ?? [];
}

/**
 * Puts the roles an instrument has switched off back on the engine, which loads with all of them
 * on. Reads the offered roles from the engine, because only it knows what the file holds. An
 * instrument with nothing switched off is already playing as it should and is left alone.
 */
export async function restoreRoles(instrument: string | null): Promise<void> {
  const off = await keptOff(instrument);
  if (!off.length) return;
  const { roles } = await invoke<{ roles: Role[] }>('audio_status');
  await invoke('audio_set_roles', { roles: roles.filter((one) => !off.includes(one)) });
}

/**
 * `roles` is what the loaded instrument offers, from the engine's status, and `round` goes up
 * whenever the instrument changed, which is when the engine has forgotten the set.
 */
export function RolesSection({
  roles = [],
  instrument,
  round = 0,
}: {
  roles?: Role[];
  instrument?: string | null;
  round?: number;
}) {
  const [off, setOff] = useState<Role[]>([]);
  const offered = roles.join(' ');

  useEffect(() => {
    if (!roles.length) return;
    let live = true;
    void (async () => {
      const kept = await keptOff(instrument ?? null);
      if (!live) return;
      setOff(kept);
      await invoke('audio_set_roles', { roles: roles.filter((one) => !kept.includes(one)) });
    })().catch(console.error);
    return () => {
      live = false;
    };
    // `offered` stands in for `roles`, which is a fresh array on every status the tab reads.
  }, [instrument, round, offered]);

  /** Switches one role: the setting first, so a crash after it still plays what the user chose. */
  async function toggle(role: Role): Promise<void> {
    const next = off.includes(role) ? off.filter((one) => one !== role) : [...off, role];
    setOff(next);
    if (instrument) {
      const all = await getSettingOr('instrument_roles');
      await setSetting('instrument_roles', { ...all, [instrument]: next });
    }
    await invoke('audio_set_roles', { roles: roles.filter((one) => !next.includes(one)) });
  }

  if (!roles.length) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Roles</h3>
      {roles.map((role) => {
        const on = !off.includes(role);
        return (
          <div
            key={role}
            id={rowId(`role_${role}`)}
            className="flex min-h-8 items-center justify-between gap-3 py-1 text-[12px]"
          >
            <span className="flex-none">{LABELS[role]}</span>
            <button
              aria-label={LABELS[role]}
              aria-pressed={on}
              onClick={() => void toggle(role).catch(console.error)}
              className={`border-edge h-6 flex-none border px-2 text-[11.5px] font-medium ${
                on ? 'bg-ink text-paper' : 'hover:bg-ink/8'
              }`}
            >
              {on ? 'On' : 'Off'}
            </button>
          </div>
        );
      })}
    </section>
  );
}
