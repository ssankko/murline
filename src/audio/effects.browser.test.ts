import { EffectsSection } from '@/audio/effects';
import type { EffectSlot } from '@/bindings';
import { fakeRust, fakeSettings, refusal, type FakeRust } from '@/rust.fake';
import { load } from '@/settings/settings';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const REVERB = 'aufx:rvb2:appl';
const GONE = 'aumf:FR2p:FabF';
/** A plugin this Mac has and the engine cannot open, which is the other way a slot stays silent. */
const BROKEN = 'aufx:pq4x:FabF';
const BROKEN_REASON = 'Pro-Q 4 would not open';

let rust: FakeRust;

/** What the engine says of one slot: empty while it plays. */
function reasonOf(id: string): string {
  if (id === GONE) return 'not installed';
  return id === BROKEN ? BROKEN_REASON : '';
}

/** Set to refuse the next write of the chain, as an engine that is not running does. */
let refuse = '';

/** Every chain written so far, oldest first. */
function chains(): EffectSlot[][] {
  return rust.written().map(([, value]) => value as EffectSlot[]);
}

let close: (() => void) | null = null;

beforeEach(async () => {
  refuse = '';
  rust = fakeRust({
    audio_effects: () => [
      { id: REVERB, name: 'AUReverb2', manufacturer: 'Apple' },
      { id: BROKEN, name: 'Pro-Q 4', manufacturer: 'FabFilter' },
    ],
    settings_write: ({ key, value }) => {
      if (refuse) throw refusal('refused', refuse);
      fakeSettings.set(key, value);
      return null;
    },
    // The engine holds the chain the setting put in it, and says of each slot why it is silent.
    audio_chain: () =>
      ((fakeSettings.get('effect_chain') as EffectSlot[] | undefined) ?? []).map((slot) => ({
        ...slot,
        reason: reasonOf(slot.id),
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
  expect(chains()[0]![1]).not.toHaveProperty('reason');
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

/** Adds one effect of the menu, named as the menu lists it. */
async function add(maker: string, text: () => string): Promise<void> {
  const trigger = button('Add effect');
  trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
  trigger.click();

  await vi.waitFor(() => expect(text()).toContain(`${maker} — `));
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((each) =>
    each.textContent?.startsWith(maker),
  )!;
  (item as HTMLElement).click();
}

test('an effect picked from the list lands at the end of the chain', async () => {
  const text = await open();
  await add('Apple', text);

  await vi.waitFor(() => expect(chains()).toHaveLength(1));
  expect(chains()[0]!.map((slot) => slot.id)).toEqual([REVERB, GONE, REVERB]);
});

test('an effect the engine cannot load keeps its slot and says why', async () => {
  const text = await open();
  await add('FabFilter', text);

  await vi.waitFor(() => expect(text()).toContain(`Pro-Q 4 — ${BROKEN_REASON}`));
  expect(chains()[0]!.map((slot) => slot.id)).toEqual([REVERB, GONE, BROKEN]);
});

test('a chain the engine refuses whole leaves the reason in every slot', async () => {
  const text = await open();
  refuse = 'The sound engine did not start';
  await add('FabFilter', text);

  await vi.waitFor(() => expect(text()).toContain(`Pro-Q 4 — ${refuse}`));
  expect(text()).toContain(`AUReverb2 — ${refuse}`);
});
