// The Audio dialog's Effects section: the ordered chain of effects after the instrument. The whole
// chain is one global setting, and every change here writes it and hands it to the engine, which
// answers with what it made of it: the names the plugins call themselves and the slots whose plugin
// this Mac does not have.

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getSettingOr, setSetting } from '@/db/db';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

/** One place in the chain. `missing` is the engine's word about this Mac, so it is never stored. */
export interface EffectSlot {
  /** Opaque here: the engine's name for the plugin, the same on every Mac that has it. */
  id: string;
  /** What the plugin was called when it was last seen, which is how a missing slot is named. */
  name: string;
  bypass: boolean;
  /** The plugin's own settings, base64, read out when the user closes its window. */
  state: string;
  missing?: boolean;
}

/** One installed effect, as the Add menu lists it. */
interface Effect {
  id: string;
  name: string;
  manufacturer: string;
}

/** A slot as it is stored: what the user chose, without the engine's word about it. */
function stored(slot: EffectSlot): EffectSlot {
  return { id: slot.id, name: slot.name, bypass: slot.bypass, state: slot.state };
}

export function EffectsSection() {
  const [slots, setSlots] = useState<EffectSlot[]>([]);
  const [available, setAvailable] = useState<Effect[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);

  /** Hands the chain to the engine and takes its answer, which marks what it could not load. */
  async function push(chain: EffectSlot[]): Promise<void> {
    setSlots(chain);
    try {
      setSlots(await invoke<EffectSlot[]>('audio_set_chain', { chain: chain.map(stored) }));
    } catch {
      // No engine: the chain is still the user's to build, it simply plays through nothing.
    }
  }

  /** Every change the user makes: written first, so a crash after it still opens on this chain. */
  async function change(chain: EffectSlot[]): Promise<void> {
    await setSetting('effect_chain', chain.map(stored)).catch(console.error);
    await push(chain);
  }

  useEffect(() => {
    getSettingOr('effect_chain').then(push, console.error);
    invoke<Effect[]>('audio_effects').then(setAvailable, () => setAvailable([]));
  }, []);

  // Closing a plugin's window is the other way the chain changes: the engine has read the plugin's
  // settings out of it and hands the whole chain back to be written.
  useEffect(() => {
    const stop = listen<EffectSlot[]>('audio-chain-changed', (event) => {
      change(event.payload).catch(console.error);
    }).catch(() => () => {});
    return () => void stop.then((off) => off());
  }, []);

  function edit(at: number, slot: EffectSlot): void {
    change(slots.map((held, index) => (index === at ? slot : held))).catch(console.error);
  }

  function drop(at: number): void {
    if (dragging === null || dragging === at) return;
    const moved = [...slots];
    moved.splice(at, 0, ...moved.splice(dragging, 1));
    setDragging(null);
    change(moved).catch(console.error);
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-[13px] font-semibold">Effects</h3>

      {slots.map((slot, at) => (
        <div
          key={`${slot.id}-${at}`}
          draggable
          onDragStart={() => setDragging(at)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => drop(at)}
          className="border-edge flex min-h-8 items-center gap-2 border px-2 py-1 text-[12px]"
        >
          <span className="mr-auto min-w-0 truncate">
            {slot.name}
            {slot.missing && <span className="text-muted-ink"> — not installed</span>}
          </span>
          <button
            aria-pressed={slot.bypass}
            onClick={() => edit(at, { ...slot, bypass: !slot.bypass })}
            className={`border-edge h-6 flex-none border px-2 text-[11.5px] font-medium ${
              slot.bypass ? 'bg-ink text-paper' : 'hover:bg-ink/8'
            }`}
          >
            Bypass
          </button>
          <Button
            variant="outline"
            size="sm"
            className="h-6 flex-none px-2 text-[11.5px]"
            disabled={slot.missing}
            onClick={() => void invoke('audio_show_effect', { index: at }).catch(console.error)}
          >
            Show
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 flex-none px-2 text-[11.5px]"
            onClick={() => change(slots.filter((_, index) => index !== at)).catch(console.error)}
          >
            Remove
          </Button>
        </div>
      ))}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 self-start text-[12px]">
            <Plus className="size-3.5" />
            Add effect
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
          {available.map((effect) => (
            <DropdownMenuItem
              key={effect.id}
              className="text-[13px]"
              onSelect={() =>
                change([
                  ...slots,
                  { id: effect.id, name: effect.name, bypass: false, state: '' },
                ]).catch(console.error)
              }
            >
              {effect.manufacturer} — {effect.name}
            </DropdownMenuItem>
          ))}
          {!available.length && (
            <DropdownMenuItem disabled className="text-[13px]">
              No effects installed
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </section>
  );
}
