// The Sound tab's effect chain: the ordered chain of effects after the instrument. The whole
// chain is one global setting; writing it is what hands it to the engine, and the engine's own
// chain is read back after, for the names the plugins call themselves and the slots whose plugin
// this Mac does not have.

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { set, setting } from '@/settings/settings';
import { rowId } from '@/lib/utils';
import { Toggle } from '@/look/rows';
import { call, on, type Effect, type EffectSlot } from '@/rust';
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

/** A slot as it is stored: what the user chose, without the engine's word about it. */
function stored(slot: EffectSlot): EffectSlot {
  return { id: slot.id, name: slot.name, bypass: slot.bypass, state: slot.state };
}

export function EffectsSection({ marked }: { marked?: string | null | undefined }) {
  const [slots, setSlots] = useState<EffectSlot[]>([]);
  const [available, setAvailable] = useState<Effect[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);

  /** What the engine made of the chain: the plugin names and the slots it could not load. An
   * engine with nothing in it leaves the user's own chain on the page. */
  async function readEngine(chain: EffectSlot[]): Promise<void> {
    const made = await call('audio_chain').catch(() => []);
    setSlots(made.length ? made : chain);
  }

  /** Every change the user makes. The write is what puts the chain in the engine. */
  async function change(chain: EffectSlot[]): Promise<void> {
    setSlots(chain);
    await set('effect_chain', chain.map(stored));
    await readEngine(chain);
  }

  useEffect(() => {
    const kept = setting('effect_chain');
    setSlots(kept);
    void readEngine(kept);
    call('audio_effects').then(setAvailable, () => setAvailable([]));
  }, []);

  // Closing a plugin's window is the other way the chain changes: the engine has read the plugin's
  // settings out of it and hands the whole chain back to be written.
  useEffect(
    () =>
      on('audio-chain-changed', (chain) => {
        change(chain).catch(console.error);
      }),
    [],
  );

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
    <section
      id={rowId('effect_chain')}
      data-marked={marked === 'effect_chain' || undefined}
      className={`flex flex-col gap-2 ${marked === 'effect_chain' ? 'bg-ink/8' : ''}`}
    >
      <h3 className="text-[13px] font-semibold">Effect chain</h3>
      <p className="text-muted-ink text-[11px] leading-snug">
        Audio Units between the instrument and the output. Drag to reorder.
      </p>

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
          {/* On is the slot playing; Off is the plugin's own bypass, which keeps its place in the
              chain and its settings. */}
          <Toggle
            value={!slot.bypass}
            disabled={slot.missing}
            onChange={(on) => edit(at, { ...slot, bypass: !on })}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-6 flex-none px-2 text-[11.5px]"
            disabled={slot.missing}
            onClick={() => void call('audio_show_effect', { index: at }).catch(console.error)}
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
