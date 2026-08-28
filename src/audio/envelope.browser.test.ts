import { EnvelopeSection, travelled, type Envelope } from '@/audio/envelope';
import type { Sounding } from '@/audio/sounding';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vitest/browser';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const OWN: Envelope = { attack: 0.01, decay: 0.5, sustain: 0.8, release: 0.2 };

let answer: Envelope | null = OWN;
let sent: [string, unknown][] = [];
/** How long the engine takes over an envelope, which a test that watches it waiting holds open. */
let taking = Promise.resolve();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    sent.push([command, args]);
    if (command === 'audio_envelope') return answer;
    if (command === 'audio_set_envelope') return taking.then(() => null);
    throw new Error(`unexpected command ${command}`);
  },
}));

let kept: Record<string, Envelope> = {};
let written: [string, unknown][] = [];

vi.mock('@/db/db', () => ({
  getSettingOr: async () => kept,
  setSetting: async (key: string, value: unknown) => {
    written.push([key, value]);
  },
}));

let close: (() => void) | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  answer = OWN;
  sent = [];
  written = [];
  kept = {};
  taking = Promise.resolve();
});

afterEach(() => {
  close?.();
  close = null;
  host = null;
});

function down(midi: number, at = performance.now()): Sounding {
  return { midi, velocity: 80, on: true, at, held: 0 };
}

function up(midi: number, held: number, at = performance.now()): Sounding {
  return { midi, velocity: 80, on: false, at, held };
}

function mount(sounding: Sounding[] = []): void {
  host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(EnvelopeSection, { sounding, instrument: 'sine.sf2' }));
  close = () => {
    root.unmount();
    host?.remove();
  };
}

async function open(sounding: Sounding[] = []): Promise<void> {
  mount(sounding);
  await vi.waitFor(() => expect(slider('Release')).toBeTruthy());
}

function slider(label: string): HTMLInputElement {
  return host!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}

function move(label: string, to: string): Promise<void> {
  return userEvent.fill(slider(label), to);
}

function line(): string {
  return host!.querySelector('polyline')!.getAttribute('points')!;
}

function dot(): SVGCircleElement | null {
  return host!.querySelector('circle');
}

function dots(): SVGCircleElement[] {
  return [...host!.querySelectorAll('circle')];
}

test('the section reads what the instrument is playing with', async () => {
  await open();
  expect(slider('Attack').value).toBe('10');
  expect(slider('Decay').value).toBe('500');
  expect(slider('Sustain').value).toBe('80');
  expect(slider('Release').value).toBe('200');
});

test('an instrument with no envelope of its own is not offered one', async () => {
  answer = null;
  mount();
  await vi.waitFor(() => expect(sent).toContainEqual(['audio_envelope', undefined]));
  expect(host!.textContent).toBe('');
});

test('the plot follows the slider at once and the engine hears it once the hand rests', async () => {
  await open();
  const before = line();

  await move('Release', '2000');
  expect(line()).not.toBe(before);
  expect(sent.some(([command]) => command === 'audio_set_envelope')).toBe(false);

  // Only the envelope the hand came to rest on is sent, not every step it passed through.
  await move('Release', '3000');
  await vi.waitFor(
    () =>
      expect(sent).toContainEqual([
        'audio_set_envelope',
        { envelope: { ...OWN, release: 3 } },
      ]),
    { timeout: 2000 },
  );
  expect(sent.filter(([command]) => command === 'audio_set_envelope')).toHaveLength(1);
});

test('the section says while the engine is taking the envelope in', async () => {
  let done!: () => void;
  taking = new Promise<void>((resolve) => (done = resolve));
  await open();
  expect(host!.textContent).not.toContain('going in');

  await move('Release', '2000');
  await vi.waitFor(() => expect(host!.textContent).toContain('going in'), { timeout: 2000 });

  done();
  await vi.waitFor(() => expect(host!.textContent).not.toContain('going in'));
});

test('the envelope is kept under the instrument it was shaped for', async () => {
  kept = { 'other.sf2': OWN };
  await open();

  await move('Sustain', '40');
  await vi.waitFor(
    () =>
      expect(written).toContainEqual([
        'instrument_envelopes',
        { 'other.sf2': OWN, 'sine.sf2': { ...OWN, sustain: 0.4 } },
      ]),
    { timeout: 2000 },
  );
});

test('a key let go partway up the attack falls from there, not from the sustain', () => {
  const slow: Envelope = { attack: 1, decay: 1, sustain: 0.5, release: 1 };
  const now = performance.now();
  // Held a quarter of the way up the attack, so it lets go at a quarter of full loudness, and half
  // a release later it is at half of that.
  const early = travelled(up(60, 250, now - 500), slow, now)!;
  expect(early.level).toBeCloseTo(0.125, 3);

  // Held past the decay, it lets go from the sustain instead.
  const late = travelled(up(60, 3000, now - 500), slow, now)!;
  expect(late.level).toBeCloseTo(0.25, 3);

  // And once the release has run out there is nothing left to draw.
  expect(travelled(up(60, 3000, now - 1500), slow, now)).toBeNull();
});

test('every key under the hands travels the line, and the key coming up runs it off the end', async () => {
  await open();
  expect(dot()).toBeNull();

  close?.();
  await open([down(60), down(64), down(67)]);
  await vi.waitFor(() => expect(dots().length).toBe(3));
  expect(new Set(dots().map((one) => one.getAttribute('fill'))).size).toBe(3);

  // A held key comes to rest partway along, with the release still ahead of it.
  const along = Number(dot()!.getAttribute('cx'));
  const end = Number(line().split(' ').pop()!.split(',')[0]);
  await vi.waitFor(() => expect(Number(dot()!.getAttribute('cx'))).toBeGreaterThan(along));
  expect(Number(dot()!.getAttribute('cx'))).toBeLessThan(end);

  // The key coming up sends it the rest of the way, and it is gone once the release has run out.
  close?.();
  await open([up(60, 1000)]);
  await vi.waitFor(() => expect(dots().length).toBe(0), { timeout: 2000 });
});
