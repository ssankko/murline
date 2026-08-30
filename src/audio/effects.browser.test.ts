import { EffectsSection } from '@/audio/effects';
import type { EffectSlot } from '@/rust';
import { fakeRust, fakeSettings, type FakeRust } from '@/rust.fake';
import { load } from '@/settings/settings';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const REVERB = 'aufx:rvb2:appl';
const GONE = 'aumf:FR2p:FabF';

let rust: FakeRust;

/** Every chain written so far, oldest first. */
function chains(): EffectSlot[][] {
  return rust.written().map(([, value]) => value as EffectSlot[]);
}

let close: (() => void) | null = null;

beforeEach(async () => {
  rust = fakeRust({
    audio_effects: () => [{ id: REVERB, name: 'AUReverb2', manufacturer: 'Apple' }],
    // The engine holds the chain the setting put in it, and marks a plugin it does not have.
    audio_chain: () =>
      ((fakeSettings.get('effect_chain') as EffectSlot[] | undefined) ?? []).map((slot) => ({
        ...slot,
        missing: slot.id === GONE,
      })),
  });
  fakeSettings.set('effect_chain', [
    { id: REVERB, name: 'AUReverb2', bypass: false, state: '' },
    { id: GONE, name: 'Pro-R 2', bypass: false, state: 'AAAA' },
  ]);
  await load();
});

afterEach(() => {
  close?.();
  close = null;
});

/** Mounts the section and hands back the text the user can read in it. */
async function open(): Promise<() => string> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(EffectsSection));
  close = () => {
    root.unmount();
    host.remove();
  };
  const text = (): string => document.body.textContent ?? '';
  await vi.waitFor(() => expect(text()).toContain('AUReverb2'));
  return text;
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].filter(
    (each) => each.textContent?.trim() === label,
  );
  expect(found.length, `one button reading ${label}`).toBeGreaterThan(0);
  return found[0]!;
}

test('the chain is listed in order, and a plugin this Mac does not have reads as missing', async () => {
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain('not installed'));
  expect(text().indexOf('AUReverb2')).toBeLessThan(text().indexOf('Pro-R 2'));
  expect(text()).toContain('Pro-R 2 — not installed');
});

test('a slot switched off writes the whole chain and keeps every other slot as it was', async () => {
  await open();
  // On is the slot playing, so Off is what puts the plugin's own bypass on.
  expect(button('On').getAttribute('aria-pressed')).toBe('true');
  button('Off').click();

  await vi.waitFor(() => expect(chains()).toHaveLength(1));
  expect(chains()[0]).toEqual([
    { id: REVERB, name: 'AUReverb2', bypass: true, state: '' },
    { id: GONE, name: 'Pro-R 2', bypass: false, state: 'AAAA' },
  ]);
  // What is stored is the user's chain, never the engine's word about this Mac.
  expect(chains()[0]![1]).not.toHaveProperty('missing');
});

test('removing a slot writes the chain without it', async () => {
  const text = await open();
  button('Remove').click();

  await vi.waitFor(() => expect(chains()).toHaveLength(1));
  expect(chains()[0]!.map((slot) => slot.id)).toEqual([GONE]);
  await vi.waitFor(() => expect(text()).not.toContain('AUReverb2'));
});

test('Show asks the engine for that slot, and a missing plugin has nothing to show', async () => {
  await open();
  const buttons = [...document.querySelectorAll('button')].filter(
    (each) => each.textContent?.trim() === 'Show',
  );
  expect(buttons[1]!.disabled, 'the missing plugin cannot be shown').toBe(true);

  buttons[0]!.click();
  await vi.waitFor(() => expect(rust.argsOf('audio_show_effect')).toEqual([{ index: 0 }]));
});

test('an effect picked from the list lands at the end of the chain', async () => {
  const text = await open();
  const add = button('Add effect');
  add.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  add.click();

  await vi.waitFor(() => expect(text()).toContain('Apple — AUReverb2'));
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((each) =>
    each.textContent?.includes('Apple'),
  )!;
  (item as HTMLElement).click();

  await vi.waitFor(() => expect(chains()).toHaveLength(1));
  expect(chains()[0]!.map((slot) => slot.id)).toEqual([REVERB, GONE, REVERB]);
});
