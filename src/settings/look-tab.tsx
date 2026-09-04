// The settings panel's Look tab: the theme, then what the sheet, the falling notes and the keyboard
// under them each draw.

import { type LaneHarmony, LOOKAHEAD_MAX, LOOKAHEAD_MIN } from "@/lane/lane";
import { Row, Rows, Segmented, Slider, Toggle } from "@/look/rows";
import type { Theme } from "@/look/use-dark";
import type { KeyboardPreset } from "@/play/settings";
import { bind, CustomRange, Section } from "@/settings/controls";
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
      {/* The tab strip's own border stands right above this group, so the group leaves its top
        hairline off. */}
      <Rows top={false}>
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
            hint="Off keeps the spacing the score file was written with."
          >
            <Toggle {...bind(values, "sheet_proportional")} />
          </Row>
          <Slider
            id="sheet_spacing"
            hint="How far apart the notes stand; a pinch does it too."
            unit="%"
            min={SPACING_MIN}
            max={SPACING_MAX}
            step={5}
            disabled={!values.sheet_proportional}
            {...bind(values, "sheet_spacing")}
          />
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
          <Slider
            id="lane_lookahead"
            hint="How many beats are in view at once."
            unit=" beats"
            min={LOOKAHEAD_MIN}
            max={LOOKAHEAD_MAX}
            step={0.1}
            {...bind(values, "lane_lookahead")}
          />
          <Slider
            id="lane_note_width"
            hint="How wide a note is against the key it lands on."
            unit="%"
            min={10}
            max={100}
            {...bind(values, "lane_note_width")}
          />
          <Slider
            id="lane_gap"
            hint="Space between two notes that follow on the same key."
            unit=" px"
            min={0}
            max={20}
            {...bind(values, "lane_gap")}
          />
          <Row id="lane_names">
            <Toggle {...bind(values, "lane_names")} />
          </Row>
          <Row
            id="lane_harmony"
            hint="Chord names at the top right of the falling notes."
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
            hint="Dims the keys that are not in the current key."
          >
            <Toggle {...bind(values, "keyboard_scale_marks")} />
          </Row>
          <Row
            id="keyboard_size"
            hint="How many keys are drawn under the falling notes."
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
