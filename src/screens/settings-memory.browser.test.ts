// The panel opens where it was left: a real column that scrolls, and a database that keeps what is
// written to it, so a second mount is the next launch.

import { NO_STATUS } from '@/rust';
import { fakeRust } from '@/rust.fake';
import { SettingsPanel } from '@/screens/settings';
import { userEvent } from 'vitest/browser';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// A Mac with the engine up and nothing installed on it, so the panel's rows are its own.
beforeEach(() => {
  fakeRust({
    audio_status: () => ({ ...NO_STATUS, available: true }),
    audio_output_devices: () => [],
    audio_instruments: () => [],
  });
});

/** The `setting` table, as JSON under each key. */
const stored = new Map<string, string>();

vi.mock('@tauri-apps/plugin-sql', () => ({
  default: {
    load: async () => ({
      select: async (_sql: string, args?: string[]) => {
        if (!args) return [...stored].map(([key, value]) => ({ key, value }));
        const value = stored.get(args[0]!);
        return value === undefined ? [] : [{ value }];
      },
      execute: async (_sql: string, args: string[]) => {
        stored.set(args[0]!, args[1]!);
      },
    }),
  },
}));

// The app's stylesheet is Tailwind's and is not built for a test, so the column is given here the
// height and the scroll its classes carry in the app.
document.head.append(
  Object.assign(document.createElement('style'), {
    textContent: '[role="dialog"] .overflow-y-auto.px-4 { height: 220px; overflow-y: auto; }',
  }),
);

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  stored.clear();
});

/** Mounts an open panel and waits for the settings read to land its rows on the page. */
async function open(props: Record<string, unknown> = {}): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(SettingsPanel, { open: true, onClose: () => {}, ...props }));
  await vi.waitFor(() => expect(document.querySelector('[role="tabpanel"]')).toBeTruthy());
}

/** Shuts the app down: the panel goes, the database stays. */
function quit(): void {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
}

/** The scrolling column, which is what holds the open tab's rows. */
function column(): HTMLElement {
  return document.querySelector('[role="tabpanel"]')!.parentElement!;
}

function activeTab(): string {
  return document.querySelector('[role="tab"][data-state="active"]')!.textContent!;
}

async function openTab(label: string): Promise<void> {
  const trigger = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    (each) => each.textContent === label,
  )!;
  await userEvent.click(trigger);
}

function setting(key: string): unknown {
  const value = stored.get(key);
  return value === undefined ? undefined : JSON.parse(value);
}

test('the panel opens on the tab and the place it was left', async () => {
  await open();
  expect(activeTab()).toBe('Sound');

  await openTab('Look');
  const box = column();
  const room = box.scrollHeight - box.clientHeight;
  expect(room, 'the Look tab is longer than the panel is tall').toBeGreaterThan(40);
  const offset = Math.round(room / 2);
  box.scrollTop = offset;

  // The write rests behind the scrolling, so the value lands about 300 ms after the last move.
  await vi.waitFor(() => expect(setting('settings_scroll')).toBe(offset));
  expect(setting('settings_tab')).toBe('look');

  quit();
  await open();
  await vi.waitFor(() => expect(activeTab()).toBe('Look'));
  await vi.waitFor(() => expect(column().scrollTop).toBe(offset));
});

test('another tab opens at the top', async () => {
  await open();
  await openTab('Look');
  const box = column();
  box.scrollTop = box.scrollHeight - box.clientHeight;
  await vi.waitFor(() => expect(setting('settings_scroll')).toBeGreaterThan(0));

  await openTab('Playing');
  expect(column().scrollTop).toBe(0);
  expect(setting('settings_scroll')).toBe(0);
  expect(setting('settings_tab')).toBe('playing');
});

test('a row to open on wins over the place the panel was left', async () => {
  stored.set('settings_tab', JSON.stringify('look'));
  stored.set('settings_scroll', JSON.stringify(120));

  await open({ jumpTo: 'library_folder' });
  await vi.waitFor(() => expect(activeTab()).toBe('Library'));
  expect(document.querySelector('#setting-row-library_folder')?.getAttribute('data-marked')).toBe(
    'true',
  );
});

// The write rests 300 ms behind the scrolling and a tab switch writes 0 at once, so what the
// database is left holding has to be the new tab's top rather than the old tab's offset.
test('a scroll write still resting when the tab changes never lands', async () => {
  await open();
  await openTab('Look');
  const box = column();
  box.scrollTop = box.scrollHeight - box.clientHeight;
  await new Promise((done) => setTimeout(done, 100));

  await openTab('Playing');
  await new Promise((done) => setTimeout(done, 500));
  expect(setting('settings_scroll')).toBe(0);
  expect(column().scrollTop).toBe(0);
});
