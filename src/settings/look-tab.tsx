// The settings panel's Look tab: the theme, then what the sheet, the falling notes and the keyboard
// under them each draw.

import { type LaneHarmony, LOOKAHEAD_MAX, LOOKAHEAD_MIN } from "@/lane/lane";
import { Row, Rows, Segmented, Toggle } from "@/look/rows";
import type { Theme } from "@/look/use-dark";
import type { KeyboardPreset } from "@/play/settings";
import { bind, CustomRange, Section, Slider } from "@/settings/controls";
import { set, useSettings } from "@/settings/settings";
import { SPACING_MAX, SPACING_MIN } from "@/sheet/sheet";

const THEMES: [Theme, string][] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

const HARMONY: [LaneHarmony, string][] = [
  ["panels", "Panels"],
  ["wheel", "Wheel"],
  ["off", "Off"],
];

const PRESETS: [KeyboardPreset, string][] = [
  ["piece", "Piece"],
  [25, "25"],
  [49, "49"],
  [61, "61"],
  [76, "76"],
  [88, "88"],
  ["custom", "Custom"],
];

export function LookTab() {
  const values = useSettings();

  return (
    <>
      <Rows>
        <Row id="theme">
          <Segmented options={THEMES} {...bind(values, "theme")} />
        </Row>
      </Rows>

      {/* Sheet and falling notes each carry their own harmony and their own colours, so
        each heading names the view its rows move and nothing else. */}
      <Section title="Sheet">
        <Rows>
          <Row
            id="sheet_proportional"
            hint="Off keeps the engraving's own spacing."
          >
            <Toggle {...bind(values, "sheet_proportional")} />
          </Row>
          <Row
            id="sheet_spacing"
            hint="A pinch on the sheet moves it too."
          >
            <Slider
              label="Sheet spacing in percent"
              unit="%"
              min={SPACING_MIN}
              max={SPACING_MAX}
              step={5}
              disabled={!values.sheet_proportional}
              {...bind(values, "sheet_spacing")}
            />
          </Row>
          <Row
            id="sheet_harmony"
            hint="Names the chord at the cursor and the two after it."
          >
            <Toggle {...bind(values, "sheet_harmony")} />
          </Row>
          <Row id="sheet_colour">
            <Toggle {...bind(values, "sheet_colour")} />
          </Row>
        </Rows>
      </Section>

      <Section title="Falling notes">
        <Rows>
          <Row
            id="lane_lookahead"
            hint="How many beats are in view at once."
          >
            <Slider
              label="Lane lookahead in beats"
              unit=" beats"
              min={LOOKAHEAD_MIN}
              max={LOOKAHEAD_MAX}
              step={0.1}
              {...bind(values, "lane_lookahead")}
            />
          </Row>
          <Row
            id="lane_note_width"
            hint="Part of its key's width."
          >
            <Slider
              label="Note width in percent"
              unit="%"
              min={10}
              max={100}
              step={1}
              {...bind(values, "lane_note_width")}
            />
          </Row>
          <Row
            id="lane_gap"
            hint="Cut between two blocks that follow each other."
          >
            <Slider
              label="Gap in pixels"
              unit=" px"
              min={0}
              max={20}
              step={1}
              {...bind(values, "lane_gap")}
            />
          </Row>
          <Row id="lane_names">
            <Toggle {...bind(values, "lane_names")} />
          </Row>
          <Row
            id="lane_harmony"
            hint="Chord names at the lane's top right."
          >
            <Segmented options={HARMONY} {...bind(values, "lane_harmony")} />
          </Row>
          <Row id="lane_colour">
            <Toggle {...bind(values, "lane_colour")} />
          </Row>
        </Rows>
      </Section>

      {/* The keys drawn under the falling notes, which the sheet knows nothing of. */}
      <Section title="Keyboard">
        <Rows>
          <Row id="keyboard_labels">
            <Toggle {...bind(values, "keyboard_labels")} />
          </Row>
          <Row
            id="keyboard_scale_marks"
            hint="Ghosts what the key in force does not hold."
          >
            <Toggle {...bind(values, "keyboard_scale_marks")} />
          </Row>
          <Row
            id="keyboard_size"
            hint="Keys the lane draws under the falling notes."
          >
            <Segmented options={PRESETS} {...bind(values, "keyboard_preset")} />
          </Row>
          {values.keyboard_preset === "custom" && (
            <Row label="Custom range">
              <CustomRange
                lo={values.keyboard_lo}
                hi={values.keyboard_hi}
                onChange={(lo, hi) => {
                  void set("keyboard_lo", lo);
                  void set("keyboard_hi", hi);
                }}
              />
            </Row>
          )}
        </Rows>
      </Section>
    </>
  );
}
