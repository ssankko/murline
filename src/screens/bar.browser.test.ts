import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyPopover } from '@/screens/bar';
import { userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
});

/** Mounts the readout for one key under the provider the bar's buttons need. */
async function mount(at: { tick: number; sharps: number; mode: number } | null): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(TooltipProvider, null, createElement(KeyPopover, { at })));
  await vi.waitFor(() => expect(host!.childElementCount).toBe(at ? 1 : 0));
}

const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-label^="Key"]');

test('the readout names the key and opens on its table of degrees', async () => {
  await mount({ tick: 0, sharps: 2, mode: 0 });
  const button = trigger()!;
  expect(button.textContent).toContain('D major');

  await userEvent.click(button);
  const content = await vi.waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-slot="popover-content"]');
    expect(found).toBeTruthy();
    return found!;
  });
  const text = content.textContent!;
  for (const each of ['2 sharps', 'dominant', 'F♯m', 'D F♯ A', 'A7', 'C♯ø7']) {
    expect(text).toContain(each);
  }
  expect(text).toContain('relative B minor · parallel D minor');
});

test('a piece with no key yet draws nothing', async () => {
  await mount(null);
  expect(trigger()).toBeNull();
});
