import { NO_STATUS } from "@/rust";
import { fakeRust, fakeSettings, type FakeRust } from "@/rust.fake";
import {
  audioDot,
  latencyLabel,
  midiDot,
  opensSettings,
  soundLabel,
  StatusBar,
} from "@/screens/status-bar";
import { load } from "@/settings/settings";
import { createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";

const PLAYING = {
  ...NO_STATUS,
  available: true,
  instrument: "Concert Grand Piano",
  buffer_frames: 256,
  sample_rate: 44100,
  instrument_rate: 44100,
  latency_ms: 12,
};

test("the MIDI dot is green while a keyboard is listened to and red when MIDI is unreachable", () => {
  expect(midiDot(["Roland"], null)).toBe("on");
  expect(midiDot([], null)).toBe("off");
  expect(midiDot(["Roland"], "MIDI is unavailable")).toBe("bad");
});

test("the audio dot is red while the sound is down or has fallen back to another device", () => {
  expect(audioDot(PLAYING)).toBe("on");
  expect(audioDot({ ...PLAYING, instrument: "" })).toBe("off");
  expect(
    audioDot({ ...NO_STATUS, reason: "No sound engine on this platform" }),
  ).toBe("bad");
  expect(
    audioDot({ ...PLAYING, fallback: "Your chosen device is not connected" }),
  ).toBe("bad");
  // Nothing has answered yet, which is not something to alarm anyone about.
  expect(audioDot(null)).toBe("off");
});

test("the sound line names the instrument and the effects after it, in the order they play", () => {
  const chain = [slot("Chorus"), slot("AUMatrixReverb")];
  expect(soundLabel(PLAYING, chain)).toBe(
    "Concert Grand Piano → Chorus → AUMatrixReverb",
  );
  expect(soundLabel(PLAYING, [])).toBe("Concert Grand Piano");
  expect(soundLabel({ ...PLAYING, instrument: "" }, chain)).toBe(
    "No instrument → Chorus → AUMatrixReverb",
  );
  // A dead engine has no chain worth naming; it says why it is silent instead.
  expect(soundLabel({ ...NO_STATUS, reason: "No output device" }, chain)).toBe(
    "No output device",
  );
});

test("the latency tooltip names the buffer and the rate the milliseconds come from", () => {
  expect(latencyLabel(PLAYING)).toBe("Output latency: 256 frames at 44.1 kHz");
  expect(
    latencyLabel({ ...PLAYING, sample_rate: 48000, buffer_frames: 512 }),
  ).toBe("Output latency: 512 frames at 48 kHz");
  expect(latencyLabel(null)).toBe("Output latency");
  expect(latencyLabel(NO_STATUS)).toBe("Output latency");
});

test("the settings shortcut stands back for a text field and for an open dialog", () => {
  expect(opensSettings(press({ metaKey: true, key: "," }), false)).toBe(true);
  expect(opensSettings(press({ key: "," }), false)).toBe(false);
  expect(opensSettings(press({ metaKey: true, key: "k" }), false)).toBe(false);
  expect(opensSettings(press({ metaKey: true, key: "," }), true)).toBe(false);
  expect(
    opensSettings(press({ metaKey: true, key: ",", tagName: "INPUT" }), false),
  ).toBe(false);
  expect(
    opensSettings(
      press({ metaKey: true, key: ",", tagName: "TEXTAREA" }),
      false,
    ),
  ).toBe(false);
  expect(
    opensSettings(
      press({ metaKey: true, key: ",", tagName: "DIV", editable: true }),
      false,
    ),
  ).toBe(false);
  // The bar's own button is a button: a shortcut pressed with one focused still opens the panel.
  expect(
    opensSettings(press({ metaKey: true, key: ",", tagName: "BUTTON" }), false),
  ).toBe(true);
});

/** The event handlers the bar subscribed with, so a test can be the engine. */
/** What `audio_status` answers, which one test moves to see the latency cell hold one line. */
let latencyMs = 12;
/** What the release page holds, which one test fills to see the update button come up. */
let waiting: string | null = null;
let rust: FakeRust;

beforeEach(async () => {
  rust = fakeRust({
    audio_status: () => ({ ...PLAYING, latency_ms: latencyMs }),
    audio_chain: () => [
      { id: "reverb", name: "AUMatrixReverb", bypass: false, state: "" },
    ],
    midi_status: () => ({
      devices: ["Roland"],
      ports: [],
      pinned: null,
      error: null,
    }),
    audio_effects: () => [],
    update_check: () => waiting,
    audio_envelope: () => ({
      attack: 0.01,
      decay: 0.2,
      sustain: 0.8,
      release: 0.4,
    }),
  });
  fakeSettings.set("click_volume", 50);
  fakeSettings.set("instruments_folder", "/instruments");
  fakeSettings.set("instrument_id", "grand");
  await load();
});

let root: Root | null = null;
let host: HTMLElement | null = null;
let opened = 0;
let sound = 0;

afterEach(() => {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
  opened = 0;
  sound = 0;
  latencyMs = 12;
  waiting = null;
});

/** The screen around the bar, which is what holds the two popovers open or shut. */
function Screen() {
  const [midiOpen, onMidiOpen] = useState(false);
  const [mixerOpen, onMixerOpen] = useState(false);
  return createElement(StatusBar, {
    midiOpen,
    onMidiOpen,
    mixerOpen,
    onMixerOpen,
    onOpenSettings: () => opened++,
    onSoundSettings: () => sound++,
  });
}

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(createElement(Screen));
  await vi.waitFor(() =>
    expect(cell("Sound").textContent).toContain("Concert Grand Piano"),
  );
}

function cell(label: string): HTMLButtonElement {
  return host!.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  )!;
}

/** The numbers of the right group, in the order they stand: the two volumes, then the meters. */
function num(at: number): Element {
  return host!.querySelectorAll(".tabular-nums")[at]!;
}

/** How many line boxes an element's text takes: one client rect per line. */
function lines(element: Element): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  return range.getClientRects().length;
}

test("the bar names what is listened to and what is playing", async () => {
  await mount();

  expect(cell("MIDI devices").textContent).toBe("Roland");
  expect(cell("Sound").textContent).toBe(
    "Concert Grand Piano → AUMatrixReverb",
  );
  expect(
    cell("MIDI devices").querySelector("[data-dot]")!.getAttribute("data-dot"),
  ).toBe("on");

  // The cell is a popover trigger inside its tooltip trigger, so the click has to reach through
  // both. Radix portals the popover out of the host.
  await userEvent.click(cell("MIDI devices"));
  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("Listening to Roland"),
  );
});

test("the sound cell opens the sound popover, which carries the Sound tab controls", async () => {
  await mount();

  await userEvent.click(cell("Sound"));
  await vi.waitFor(() =>
    expect(
      document.querySelector('button[aria-label="Instrument"]')!.textContent,
    ).toContain("Concert Grand Piano"),
  );
  const shown = document.body.textContent!;
  expect(shown).toContain("Touch");
  expect(shown).toContain("Envelope");
  expect(shown).toContain("Effect chain");
  // The instruments folder belongs to the Sound tab alone, which the link at the foot reaches.
  expect(shown).not.toContain("Instruments folder");
  expect(sound).toBe(0);
});

test("the volume pair reads the two settings and opens the faders", async () => {
  await mount();
  await vi.waitFor(() => expect(num(0).textContent).toBe("100"));
  expect(num(1).textContent).toBe("50");

  // Radix portals a popover out of the host, so it is looked for on the whole page.
  await userEvent.click(cell("Volume"));
  await vi.waitFor(() =>
    expect(document.querySelector('input[aria-label="Keyboard"]')).toBeTruthy(),
  );
  expect(document.querySelector('button[aria-label="Instrument"]')).toBeNull();
});

test("a three-digit latency stays on the one line the bar is high", async () => {
  latencyMs = 161;
  await mount();
  await vi.waitFor(() => expect(num(2).textContent).toBe("161 ms"));
  expect(lines(num(2))).toBe(1);
});

test("the meters stand at a dash until the engine reports, and the load reddens past 80", async () => {
  await mount();
  // Latency comes with the status; the voices and the load wait for the render block to report.
  await vi.waitFor(() => expect(num(2).textContent).toBe("12 ms"));
  expect(num(3).textContent).toBe("—");
  expect(num(4).textContent).toBe("—");

  rust.emit("audio-load", { voices: 41, limit: 128, load: 12 });
  await vi.waitFor(() => expect(num(4).textContent).toBe("12%"));
  expect(num(3).textContent).toBe("41 / 128");
  expect(num(4).className).not.toContain("red");

  rust.emit("audio-load", { voices: 40, limit: 128, load: 94 });
  await vi.waitFor(() => expect(num(4).className).toContain("red"));
});

test("the cog and ⌘, both ask the screen to open the settings panel", async () => {
  await mount();

  await userEvent.click(cell("Settings"));
  expect(opened).toBe(1);

  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: ",", metaKey: true }),
  );
  expect(opened).toBe(2);
});

test("the version cell names what runs, and one press on it fetches what waits", async () => {
  waiting = "0.1.1";
  await mount();
  // The number and the amber mark are one button, which the waiting version renames.
  await vi.waitFor(() => expect(cell("Update").textContent).toBe("0.1.0"));

  // Nothing is fetched until that button is pressed.
  expect(rust.argsOf("update_install")).toHaveLength(0);
  await userEvent.click(cell("Update"));
  await vi.waitFor(() => expect(rust.argsOf("update_install")).toHaveLength(1));

  // With the version on disk the cell asks to be pressed again, and that press restarts the app.
  await vi.waitFor(() => expect(cell("Restart").textContent).toBe("0.1.0"));
  await userEvent.click(cell("Restart"));
  await vi.waitFor(() => expect(rust.argsOf("update_restart")).toHaveLength(1));
});

test("clicking the version asks the release page again", async () => {
  await mount();
  await vi.waitFor(() => expect(cell("Version").textContent).toBe("0.1.0"));
  expect(rust.argsOf("update_check")).toHaveLength(1);
  expect(cell("Update")).toBeNull();

  await userEvent.click(cell("Version"));
  await vi.waitFor(() => expect(rust.argsOf("update_check")).toHaveLength(2));
});

function slot(name: string) {
  return { id: name, name, bypass: false, state: "" };
}

/** A key press as the window handler sees it, with only the parts the guard reads. */
function press({
  key,
  metaKey = false,
  tagName,
  editable = false,
}: {
  key: string;
  metaKey?: boolean;
  tagName?: string;
  editable?: boolean;
}): KeyboardEvent {
  const target = tagName ? { tagName, isContentEditable: editable } : null;
  return { key, metaKey, target } as unknown as KeyboardEvent;
}
