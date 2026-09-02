// The settings panel: a centred modal opened from every screen, holding everything the app does in
// general. What the open piece does right now is the play toolbar's. Every control writes on
// change; there is no Save.

import { SoundTab } from "@/audio/sound-tab";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { clamp } from "@/lib/utils";
import { LibraryTab } from "@/settings/library-tab";
import { LookTab } from "@/settings/look-tab";
import { PlayingTab } from "@/settings/playing-tab";
import {
  markedRow,
  rowId,
  rowOf,
  SETTING_ROWS,
  type Offered,
  type SearchWhere,
  type SettingRow,
  type SettingRowId,
  type SettingsTab,
} from "@/settings/rows";
import { set, setting } from "@/settings/settings";
import { SPACING_MAX, SPACING_MIN, type Pinch } from "@/sheet/sheet";
import { commands } from "@/bindings";
import { Search } from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

export type { SettingsTab };

const TAB_LABELS: Record<SettingsTab, string> = {
  sound: "Sound",
  look: "Look",
  playing: "Playing",
  library: "Library",
};

const TABS = Object.entries(TAB_LABELS) as [SettingsTab, string][];

const WHERE_LABELS: Record<SearchWhere, string> = {
  ...TAB_LABELS,
  mixer: "Volume",
  midi: "MIDI",
};

/** Whether a result lives on a tab of the panel rather than in a popover of its own. */
function isTab(where: SearchWhere): where is SettingsTab {
  return where in TAB_LABELS;
}

/**
 * The rows whose label, tab name or one of their words holds what was typed, and that the panel
 * is showing for what the instrument playing offers.
 */
function searchRows(query: string, has: Offered): SettingRow[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return SETTING_ROWS.filter(
    (row: SettingRow) =>
      (row.shows?.(has) ?? true) &&
      [row.label, WHERE_LABELS[row.tab], row.group ?? "", ...row.words].some(
        (word) => word.toLowerCase().includes(needle),
      ),
  );
}

/** The row an element carrying the row prefix stands for: every such element took its id from the
 * table. */
function idOf(row: Element): SettingRowId {
  return row.id.slice(rowId("").length) as SettingRowId;
}

/**
 * Every app-wide setting, in four tabs, in a centred modal shaped like the score finder. The
 * overlay dims lighter than the finder's so the sheet and the lane behind stay legible and keep
 * animating while a control is moved. It reads nothing the play clock owns and writes nothing to
 * it.
 *
 * A knob the running play reads reaches the live objects through the store, so a change
 * mid-practice applies at once.
 */
export function SettingsPanel({
  open,
  onClose,
  jumpTo,
  onOpenMixer,
  onOpenMidi,
}: {
  open: boolean;
  onClose: () => void;
  /** The way to the two faders, which are the mixer's and not the panel's. A search result naming
   * one closes the panel and opens the mixer over the button it belongs to. */
  onOpenMixer?: () => void;
  /** The same for the input devices, which are the MIDI popover's. */
  onOpenMidi?: () => void;
  /** A row to open on, named by its id: the same jump a search result makes, for the callers that
   * open the panel at one row rather than at the top. */
  jumpTo?: string | null;
}) {
  const [tab, setTab] = useState<SettingsTab>("sound");
  const [query, setQuery] = useState("");
  /** Which search result the arrow keys are on. */
  const [sel, setSel] = useState(0);
  /** The row a search result jumped to, held until the next jump or the next open. */
  const marked = useSyncExternalStore(markedRow.subscribe, markedRow.get);
  /** Whether the instrument playing has an envelope, which is what puts its rows in the search. */
  const [envelope, setEnvelope] = useState(false);
  /** Whether it offers any role beyond the tone, which is what puts the four level rows there. */
  const [roles, setRoles] = useState(false);
  const list = useRef<HTMLUListElement>(null);
  const column = useRef<HTMLDivElement>(null);
  /** The search box, whose keys are its own while its results stand and the marked row's after. */
  const box = useRef<HTMLInputElement>(null);
  /** How the mark is scrolled to: a search jump lands the row in the middle of the column, a mark
   * walked or clicked moves the column no further than it must. */
  const markScroll = useRef<ScrollLogicalPosition>("center");
  /** The stored offset waiting for the column to have rows to scroll; null once placed. */
  const [opensAt, setOpensAt] = useState<number | null>(null);
  const scrollWrite = useRef<ReturnType<typeof setTimeout>>(undefined);

  // What the loaded instrument offers is asked at every open, so the search reaches the rows the
  // engine is putting on the page now.
  useEffect(() => {
    if (!open) {
      markedRow.set(null);
      setQuery("");
      setSel(0);
    }
    if (open) {
      commands.audioEnvelope().then(
        (one) => setEnvelope(one !== null),
        () => setEnvelope(false),
      );
      commands.audioStatus().then(
        (status) => setRoles(status.roles.length > 0),
        () => setRoles(false),
      );
    }
  }, [open]);

  // The tab and the mark land in one render, as they do for a search result, so the scroll effect
  // below finds the row on the page.
  useEffect(() => {
    const row = jumpTo && SETTING_ROWS.find((each) => each.id === jumpTo);
    if (!open || !row || !isTab(row.tab)) return;
    setTab(row.tab);
    markedRow.set(row.id);
  }, [open, jumpTo]);

  // Where the panel was left, taken up at every open. A `jumpTo` names the place instead, so the
  // stored one is passed over for that open.
  useEffect(() => {
    if (!open || jumpTo) return;
    setTab(setting("settings_tab"));
    setOpensAt(setting("settings_scroll"));
  }, [open, jumpTo]);

  // The column takes the offset once it is on the page, which is the render after the open.
  useEffect(() => {
    if (column.current && opensAt !== null) {
      column.current.scrollTop = opensAt;
      setOpensAt(null);
    }
  }, [opensAt]);

  // Nothing of this panel writes once it is gone, and no row of a popover keeps its mark.
  useEffect(
    () => () => {
      clearTimeout(scrollWrite.current);
      markedRow.set(null);
    },
    [],
  );

  // The mark lands in its own render and the tab switch may follow in another, so the scroll runs
  // on either, and finds the row once its tab is on the page.
  useEffect(() => {
    if (marked)
      document
        .getElementById(rowId(marked))
        ?.scrollIntoView({ block: markScroll.current });
    markScroll.current = "center";
  }, [marked, tab]);

  useEffect(() => {
    list.current
      ?.querySelector("[data-selected]")
      ?.scrollIntoView({ block: "nearest" });
  }, [sel, query]);

  /** Every tab opens at the top, so the offset held is the open tab's own. A write still resting
   * behind the old tab's scrolling would land after this one, so it is dropped. */
  function chooseTab(next: SettingsTab): void {
    clearTimeout(scrollWrite.current);
    setTab(next);
    markedRow.set(null);
    setOpensAt(null);
    if (column.current) column.current.scrollTop = 0;
    void set("settings_tab", next);
    void set("settings_scroll", 0);
  }

  // Scrolling writes far more often than the setting is worth, so only the place a scroll rests
  // at is kept.
  function onScroll(event: React.UIEvent<HTMLDivElement>): void {
    const top = event.currentTarget.scrollTop;
    clearTimeout(scrollWrite.current);
    scrollWrite.current = setTimeout(() => {
      void set("settings_scroll", top);
    }, 300);
  }

  const results = searchRows(query, { envelope, roles });
  const selected = results[Math.min(sel, results.length - 1)] ?? null;

  function pick(row: SettingRow): void {
    setQuery("");
    setSel(0);
    // A popover's control is not a row here, so the result hands the player to the popover rather
    // than to a tab that does not hold it.
    if (!isTab(row.tab)) {
      onClose();
      (row.tab === "mixer" ? onOpenMixer : onOpenMidi)?.();
      return;
    }
    chooseTab(row.tab);
    markedRow.set(row.id);
  }

  // The arrows belong to the results list alone: every slider, select and toggle on the tabs below
  // reads its own arrow keys, so the list must not take them from the whole modal. With no list up
  // the box holds no selection, and its keys are the marked row's.
  function onSearchKey(event: React.KeyboardEvent): void {
    if (query.trim() === "") return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSel((at) => Math.min(at + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSel((at) => Math.max(at - 1, 0));
    } else if (event.key === "Enter" && selected) {
      event.preventDefault();
      pick(selected);
    }
  }

  /**
   * The panel walked by keyboard: Up and Down move the mark through the rows of the open tab,
   * Space works the marked row's choice, Left and Right its slider. A held key repeats, so a
   * repeat is taken like any other press.
   */
  function onPanelKey(event: React.KeyboardEvent<HTMLDivElement>): void {
    // The results list and the tab strip answer first and mark what they took as spent.
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    // A select and a number field keep their own keys, and so does the search box while it has a
    // list under it.
    const own =
      target === box.current
        ? query.trim() !== ""
        : target.closest('select, textarea, input:not([type="range"])') !==
          null;
    if (own) return;

    const rows = [
      ...event.currentTarget.querySelectorAll<HTMLElement>(
        '[id^="setting-row-"]',
      ),
    ]
      // A row of a tab that is not open is on the page but out of the walk.
      .filter((row) => row.offsetParent !== null);
    const at = rows.findIndex((row) => idOf(row) === marked);

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next =
        rows[
          clamp(at + (event.key === "ArrowDown" ? 1 : -1), 0, rows.length - 1)
        ];
      if (!next) return;
      markScroll.current = "nearest";
      markedRow.set(idOf(next));
      return;
    }

    const row = rows[at];
    if (!row) return;
    if (event.key === " " && press(row)) event.preventDefault();
    const way =
      event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (way !== 0 && slide(row, way, event.shiftKey)) event.preventDefault();
  }

  // A click or a tab into a control marks the row it sits in, so the keys carry on from there.
  function onPanelFocus(event: React.FocusEvent<HTMLDivElement>): void {
    const row = (event.target as HTMLElement).closest('[id^="setting-row-"]');
    if (!row) return;
    markScroll.current = "nearest";
    markedRow.set(idOf(row));
  }

  return (
    // Radix owns the overlay, the focus trap, Escape and the click outside. Its content carries
    // `role="dialog"` with `data-state="open"`, which is what the play screen's keys watch for:
    // while the panel is open, Space and Escape are the panel's and never reach the clock.
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        // Lighter than the finder's `bg-black/50`: the sheet and the lane behind have to stay
        // readable while a look setting is moved.
        overlayClassName="bg-black/20"
        className="top-[12%] flex max-h-[70vh] w-[640px] translate-y-0 flex-col gap-0 p-0 sm:max-w-[640px]"
        // On the content rather than on each row, so the keys work wherever focus sits inside.
        onKeyDown={onPanelKey}
        onFocus={onPanelFocus}
      >
        <DialogTitle className="sr-only">Settings</DialogTitle>

        <div className="border-edge-soft relative flex flex-none items-center gap-2.5 border-b px-4">
          <Search className="text-muted-ink size-4" />
          <input
            autoFocus
            ref={box}
            value={query}
            aria-label="Search settings"
            placeholder="Search settings"
            onChange={(event) => {
              setQuery(event.target.value);
              setSel(0);
            }}
            onKeyDown={onSearchKey}
            className="placeholder:text-muted-ink flex-1 bg-transparent py-3 text-[15px] outline-none"
          />
          {query.trim() !== "" && (
            <ul
              ref={list}
              className="bg-chrome border-edge-soft absolute inset-x-0 top-full z-10 max-h-64 overflow-y-auto border shadow-md"
            >
              {results.length === 0 && (
                <li className="text-muted-ink px-4 py-3 text-[12px]">
                  Nothing matches “{query}”.
                </li>
              )}
              {results.map((row, at) => (
                <li key={row.id}>
                  <button
                    data-selected={row === selected || undefined}
                    onMouseMove={() => sel !== at && setSel(at)}
                    onClick={() => pick(row)}
                    className={`flex w-full items-baseline gap-3 px-4 py-1.5 text-left text-[12px] ${
                      row === selected ? "bg-(--fill-selected)" : ""
                    }`}
                  >
                    <span className="min-w-0 truncate">{row.label}</span>
                    <span className="text-muted-ink ml-auto flex-none text-[11px]">
                      {row.group
                        ? `${WHERE_LABELS[row.tab]} · ${row.group}`
                        : WHERE_LABELS[row.tab]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Tabs.Root
          value={tab}
          onValueChange={(next) => chooseTab(next as SettingsTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <Tabs.List className="border-edge-soft flex flex-none gap-0.5 border-b px-4 pt-3">
            {TABS.map(([each, label]) => (
              <Tabs.Trigger
                key={each}
                value={each}
                className="text-muted-ink data-[state=active]:border-ink data-[state=active]:text-ink hover:text-ink -mb-px border-b-2 border-transparent px-2 pb-1.5 text-[12px] font-medium transition-colors duration-150"
              >
                {label}
              </Tabs.Trigger>
            ))}
          </Tabs.List>

          {/* The box is a grid whose track is as wide as its widest content unless the column is let
            go under it: without min-w-0 a long path widens the whole panel. */}
          <div
            ref={column}
            onScroll={onScroll}
            className="flex min-w-0 flex-1 flex-col overflow-y-auto px-4 py-4"
          >
            {/* Radix makes every tab panel focusable, so a click in the body focuses the panel and
              the next key rings every row at once. Its rows are all controls, so the
              panel itself needs no place in the tab order. */}
            <Tabs.Content
              value="sound"
              className="flex flex-col gap-7"
              tabIndex={undefined}
            >
              {/* The two volumes are not here at all; they are the mixer's two faders. */}
              <SoundTab />
            </Tabs.Content>

            <Tabs.Content
              value="look"
              className="flex flex-col gap-6"
              tabIndex={undefined}
            >
              <LookTab />
            </Tabs.Content>

            <Tabs.Content
              value="playing"
              className="flex flex-col gap-7"
              tabIndex={undefined}
            >
              <PlayingTab />
            </Tabs.Content>

            <Tabs.Content
              value="library"
              className="flex flex-col gap-2"
              tabIndex={undefined}
            >
              <LibraryTab />
            </Tabs.Content>
          </div>
        </Tabs.Root>

        {/* Enter belongs to the results list alone; with no list up the keys are the marked row's. */}
        <footer className="border-edge-soft text-muted-ink flex flex-none justify-end gap-3 border-t px-4 py-2 text-[12px]">
          {query.trim() === "" ? (
            <>
              <span>↑↓ move</span>
              <span>space change</span>
              <span>←→ adjust</span>
            </>
          ) : (
            <>
              <span>↑↓ select</span>
              <span>↩ open</span>
            </>
          )}
          <span>esc close</span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Space on a row: presses the choice after the one pressed, wrapping, which flips a two-button
 * toggle and steps a longer set. False for a row that offers no choice, and Space stays the
 * browser's there.
 */
function press(row: HTMLElement): boolean {
  const buttons = [
    ...row.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
  ];
  if (buttons.length === 0) return false;
  const at = buttons.findIndex(
    (each) => each.getAttribute("aria-pressed") === "true",
  );
  buttons[(at + 1) % buttons.length]!.click();
  return true;
}

/**
 * Left and Right on a row: a twentieth of the slider's span, rounded to its step and never under
 * one step, or one step exactly when Shift is down and on a row whose descriptor says it steps
 * finely. False for a row with no slider to move.
 */
function slide(row: HTMLElement, way: 1 | -1, fine: boolean): boolean {
  const input = row.querySelector<HTMLInputElement>('input[type="range"]');
  // A row that folds other rows under it reaches their sliders as well; only its own answers.
  if (!input || input.disabled || input.closest('[id^="setting-row-"]') !== row)
    return false;
  const min = Number(input.min);
  const max = Number(input.max);
  const step = Number(input.step) || 1;
  const jump =
    fine || rowOf(idOf(row)).fine
      ? step
      : Math.max(step, Math.round(((max - min) * 0.05) / step) * step);
  const next = clamp(Number(input.value) + way * jump, min, max);
  // React holds the value it last rendered, and swallows a plain assignment as no change. The
  // native setter with an `input` event is the same arrival as a drag, so the row's own handler
  // writes the setting.
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(input, String(next));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

const PINCH_GAP = 12;
const PINCH_W = 200;
const PINCH_H = 40;

/**
 * What a pinch on the sheet is choosing, shown at the fingers while they move: the spacing the
 * sheet will be drawn at once they stop. It takes no input; the fingers are the control. The panel
 * holds its last place and value while it fades away, so `null` reads as the end of the pinch.
 */
export function SpacingPopup({ pinch }: { pinch: Pinch | null }) {
  const [held, setHeld] = useState<Pinch | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!pinch) {
      setShown(false);
      return;
    }
    setHeld(pinch);
    // The fade starts on the frame after the panel is on the page, so it has a state to leave.
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [pinch]);

  if (!held) return null;
  return (
    <div
      role="status"
      aria-label="Sheet spacing"
      style={{
        left: clamp(
          held.x + PINCH_GAP,
          PINCH_GAP,
          window.innerWidth - PINCH_W - PINCH_GAP,
        ),
        top: clamp(
          held.y + PINCH_GAP,
          PINCH_GAP,
          window.innerHeight - PINCH_H - PINCH_GAP,
        ),
        width: PINCH_W,
      }}
      className={`bg-chrome border-edge-soft pointer-events-none fixed z-50 flex items-center gap-2 rounded-md border px-3 py-2 text-[12px] shadow-md transition-opacity duration-150 ease-[var(--ease)] ${shown ? "opacity-100" : "opacity-0"}`}
    >
      {/* The track only draws the target; the readout beside it is what a reader is told. */}
      <input
        type="range"
        readOnly
        tabIndex={-1}
        aria-hidden
        min={SPACING_MIN}
        max={SPACING_MAX}
        value={held.spacing}
        className="accent-ink min-w-0 flex-1"
      />
      <span className="w-10 flex-none text-right tabular-nums">
        {held.spacing}%
      </span>
    </div>
  );
}
