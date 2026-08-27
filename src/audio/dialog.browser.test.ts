import { AudioDialog } from '@/audio/dialog';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, test, vi } from 'vitest';

let answer: unknown = { available: false, reason: 'No instrument chosen' };

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string) => {
    if (command === 'audio_status') return answer;
    if (command === 'audio_instruments') return [];
    throw new Error(`unexpected command ${command}`);
  },
}));

let close: (() => void) | null = null;

afterEach(() => {
  close?.();
  close = null;
});

/** Mounts the dialog and hands back the text the user can read in it. */
async function open(): Promise<() => string> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(AudioDialog, { onClose: () => {} }));
  // The box is a portal, so it lands beside the host and the whole page is what to read.
  close = () => {
    root.unmount();
    host.remove();
  };
  const text = (): string => document.body.textContent ?? '';
  await vi.waitFor(() => expect(text()).toContain('Audio'));
  return text;
}

test('the dialog holds its three sections and the reason there is no sound', async () => {
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain('No instrument chosen'));
  for (const section of ['Output', 'Instrument', 'Effects']) {
    expect(text()).toContain(section);
  }
});

test('an engine that can play says nothing about why it cannot', async () => {
  answer = { available: true, reason: '' };
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain('Effects'));
  expect(text()).not.toContain('No instrument chosen');
});
