import { EnvelopeSection, travelled } from '@/audio/envelope';
import type { Envelope } from '@/rust';
import { fakeRust, type FakeRust } from '@/rust.fake';
import type { Sounding } from '@/audio/sounding';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { userEvent } from 'vitest/browser';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const OWN: Envelope = { attack: 0.01, decay: 0.5, sustain: 0.8, release: 0.2 };

let answer: Envelope | null = OWN;
let rust: FakeRust;

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
  written = [];
  kept = {};
  rust = fakeRust({ audio_envelope: () => answer });
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
  await vi.waitFor(() => expect(rust.argsOf('audio_envelope')).toHaveLength(1));
  expect(host!.textContent).toBe('');
});

test('the plot and the engine both follow the slider as it moves', async () => {
  await open();
  const before = line();

  await move('Release', '2000');
  expect(line()).not.toBe(before);
  await vi.waitFor(() =>
    expect(rust.argsOf('audio_set_envelope')).toContainEqual({ envelope: { ...OWN, release: 2 } }),
  );

  // Still moving, and still heard: nothing waits for the hand to come off the slider, and nothing
  // warns of a silence.
  await move('Release', '3000');
  await vi.waitFor(() =>
    expect(rust.argsOf('audio_set_envelope')).toContainEqual({ envelope: { ...OWN, release: 3 } }),
  );
  expect(host!.textContent).not.toContain('going in');
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
