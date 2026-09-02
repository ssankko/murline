import { OutputSection } from "@/audio/output";
import type { AudioStatus, OutputDevice } from "@/bindings";
import { NO_STATUS } from "@/audio/sound-tab";
import { fakeRust, fakeSettings, type FakeRust } from "@/rust.fake";
import { load } from "@/settings/settings";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

let devices: OutputDevice[] = [
  { id: "BuiltInSpeakerDevice", name: "MacBook Pro Speakers" },
  { id: "Scarlett", name: "Scarlett 2i2" },
];
let status: AudioStatus = {
  ...NO_STATUS,
  available: true,
  device: "Scarlett",
  device_name: "Scarlett 2i2",
  buffer_frames: 64,
  sample_rate: 48000,
  buffer_choices: [32, 64, 128, 256, 512],
  instrument_rate: 44100,
  latency_ms: 1.9,
};
let rust: FakeRust;

/** The settings a launch starts from, in the fake's table before the section mounts. */
const STORED: Record<string, unknown> = {
  audio_output_device: "Scarlett",
  audio_buffer_frames: 64,
  audio_voices: 128,
  instrument_id: "file:/Steinway.exs",
  instruments_folder: "/instruments",
};

let close: (() => void) | null = null;

beforeEach(async () => {
  rust = fakeRust({
    audio_output_devices: () => devices,
    audio_status: () => status,
    // The section's own list is never shown, so the engine may report none.
    audio_instruments: () => [],
  });
  for (const [key, value] of Object.entries(STORED)) fakeSettings.set(key, value);
  await load();
});

afterEach(() => {
  close?.();
  close = null;
});

/** Mounts the section and hands back the text the user can read on the page. */
async function open(): Promise<() => string> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  root.render(createElement(OutputSection));
  close = () => {
    root.unmount();
    host.remove();
  };
  const text = (): string => document.body.textContent ?? "";
  await vi.waitFor(() => expect(text()).toContain("Output"));
  return text;
}

/** Opens the device picker, whose rows are a portal beside the section. */
function openPicker(): void {
  const trigger = document.querySelector('[aria-label="Output device"]');
  trigger?.dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
  );
}

/** The picker row the radio dot is on, once the picker is open. */
function checkedRow(): string {
  const found = document.querySelector(
    '[role="menuitemradio"][aria-checked="true"]',
  );
  return found?.textContent?.trim() ?? "";
}

/** Clicks what reads `label`, inside `within` when two rows offer the same number. */
function clickText(label: string, within: ParentNode = document): void {
  const found = [
    ...within.querySelectorAll('button, [role="menuitemradio"]'),
  ].find((element) => element.textContent?.trim() === label);
  if (!found) throw new Error(`nothing to click reads "${label}"`);
  for (const kind of ["pointerdown", "pointerup", "click"]) {
    found.dispatchEvent(new PointerEvent(kind, { bubbles: true, button: 0 }));
  }
}

test("the section shows the chosen device and what the engine says it costs", async () => {
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain("Scarlett 2i2"));
  expect(text()).toContain("1.9 ms at 48.0 kHz");

  openPicker();
  await vi.waitFor(() => expect(text()).toContain("MacBook Pro Speakers"));
  expect(text()).toContain("System default");
});

test("a device plugged in while the tab is open appears in the picker", async () => {
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain("Scarlett 2i2"));

  devices = [...devices, { id: "Headphones", name: "External Headphones" }];
  rust.emit("audioDevicesChanged", undefined);

  openPicker();
  await vi.waitFor(() => expect(text()).toContain("External Headphones"));
});

test("choosing a device writes the setting and moves the engine", async () => {
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain("Scarlett 2i2"));

  openPicker();
  await vi.waitFor(() => expect(text()).toContain("MacBook Pro Speakers"));
  clickText("MacBook Pro Speakers");

  await vi.waitFor(() =>
    expect(rust.written()).toContainEqual(["audio_output_device", "BuiltInSpeakerDevice"]),
  );
});

test("choosing a buffer size writes the setting and applies it", async () => {
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain("Scarlett 2i2"));

  clickText("128", document.querySelector("#setting-row-audio_buffer_frames")!);

  await vi.waitFor(() => expect(rust.written()).toContainEqual(["audio_buffer_frames", 128]));
  // The readout is asked again, because the buffer is most of what the latency is.
  await vi.waitFor(() =>
    expect(rust.argsOf("audio_status").length).toBeGreaterThan(1),
  );
});

test("choosing a voice limit writes the setting and loads the instrument again at it", async () => {
  const text = await open();
  await vi.waitFor(() => expect(text()).toContain("Scarlett 2i2"));

  clickText("512", document.querySelector("#setting-row-audio_voices")!);

  await vi.waitFor(() => expect(rust.written()).toContainEqual(["audio_voices", 512]));
  // The streaming rings are allocated with the instrument, so it goes in again at the new count.
  await vi.waitFor(() =>
    expect(rust.calls.map((one) => one.name)).toContain("audio_load_instrument"),
  );
});

test("a device that takes only the big buffers leaves the small ones dead", async () => {
  status = { ...status, buffer_choices: [256, 512] };

  const text = await open();
  await vi.waitFor(() => expect(text()).toContain("Scarlett 2i2"));

  const buttons = (): HTMLButtonElement[] => [
    ...document.querySelectorAll<HTMLButtonElement>(
      "#setting-row-audio_buffer_frames button",
    ),
  ];
  await vi.waitFor(() =>
    expect(
      buttons().map((button) => [button.textContent, button.disabled]),
    ).toEqual([
      ["32", true],
      ["64", true],
      ["128", true],
      ["256", false],
      ["512", false],
    ]),
  );
});

test("a chosen device that is not connected reads as the system default until it is back", async () => {
  devices = [{ id: "BuiltInSpeakerDevice", name: "MacBook Pro Speakers" }];
  status = {
    ...status,
    device: "BuiltInSpeakerDevice",
    device_name: "MacBook Pro Speakers",
    fallback:
      "Your chosen output device is not connected; playing through the system default",
    latency_ms: 17.9,
  };

  const text = await open();
  // The latency figure is the engine answering, by which point the setting has been read too.
  await vi.waitFor(() => expect(text()).toContain("17.9 ms"));
  // Neither the device's name nor the id it was stored under is anywhere on the page.
  expect(text()).not.toContain("Scarlett");

  openPicker();
  await vi.waitFor(() => expect(text()).toContain("MacBook Pro Speakers"));
  expect(checkedRow()).toBe("System default");
  // Saying where the sound went is the tab's one line, not a second one in this section.
  expect(text()).not.toContain("not connected");

  // The setting kept the choice, so plugging the device back in shows its name again.
  devices = [...devices, { id: "Scarlett", name: "Scarlett 2i2" }];
  rust.emit("audioDevicesChanged", undefined);

  await vi.waitFor(() => expect(checkedRow()).toBe("Scarlett 2i2"));
});

test("a buffer size this device does not take says so and shows the one running", async () => {
  status = { ...status, buffer_choices: [128, 256, 512], buffer_frames: 128 };

  const text = await open();
  await vi.waitFor(() =>
    expect(text()).toContain(
      "This device does not take 64 frames; running at 128.",
    ),
  );
  // The row stands on the size the engine settled on, not the saved one.
  const pressed = [
    ...document.querySelectorAll("#setting-row-audio_buffer_frames button"),
  ]
    .filter((each) => each.getAttribute("aria-pressed") === "true")
    .map((each) => each.textContent);
  expect(pressed).toEqual(["128"]);
});
