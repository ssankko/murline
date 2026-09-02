// The settings panel's Playing tab: the timing windows a strike is judged by, the inactive hand,
// and in a dev build the knobs that shape a Grade.

import { Row, Rows, Segmented, Toggle } from "@/look/rows";
import { INACTIVE_HAND_LEVEL, type InactiveHandVelocity } from "@/play/settings";
import { bind, Section, Slider } from "@/settings/controls";
import { GRADE_KNOBS, markedRow, rowId } from "@/settings/rows";
import { set, useSettings } from "@/settings/settings";
import { useSyncExternalStore } from "react";

const INACTIVE_HAND_VELOCITIES: [InactiveHandVelocity, string][] = [
  ["score", "From the score"],
  ["follow", "Follows you"],
];

export function PlayingTab() {
  const values = useSettings();
  /** The marked row, which unfolds the Grade knobs when it is one of them. */
  const marked = useSyncExternalStore(markedRow.subscribe, markedRow.get);

  return (
    <>
      <Section title="Timing">
        <Rows>
          <Row
            id="matching_window_ms"
            hint="How far off the beat a strike still counts."
          >
            <Slider
              label="Matching window in milliseconds"
              unit=" ms"
              min={1}
              max={1000}
              step={1}
              {...bind(values, "matching_window_ms")}
            />
          </Row>
          <Row
            id="togetherness_ms"
            hint="How far apart the notes of one chord may be struck."
          >
            <Slider
              label="Togetherness window in milliseconds"
              unit=" ms"
              min={1}
              max={1000}
              step={1}
              {...bind(values, "togetherness_ms")}
            />
          </Row>
        </Rows>
      </Section>

      {/* The velocity and the level shape a sound nothing makes while the first row is
        off, so both stand dead until it is on. */}
      <Section title="Inactive hand">
        <Rows>
          <Row
            id="play_inactive_hand"
            hint="Played as the clock passes it."
          >
            <Toggle {...bind(values, "play_inactive_hand")} />
          </Row>
          <Row
            id="play_inactive_hand_velocity"
            hint="Loudness from the written dynamics, or from your strikes."
          >
            <Segmented
              options={INACTIVE_HAND_VELOCITIES}
              disabled={!values.play_inactive_hand}
              {...bind(values, "play_inactive_hand_velocity")}
            />
          </Row>
          <Row
            id="play_inactive_hand_level"
            hint="Part of that loudness it sounds at."
          >
            <Slider
              label="Inactive hand level in percent"
              unit="%"
              min={INACTIVE_HAND_LEVEL[0]}
              max={INACTIVE_HAND_LEVEL[1]}
              step={5}
              disabled={!values.play_inactive_hand}
              {...bind(values, "play_inactive_hand_level")}
            />
          </Row>
        </Rows>
      </Section>

      {import.meta.env.DEV && (
        <details
          id={rowId("grade_tuning")}
          open={!!marked?.startsWith("grade_")}
        >
          <summary className="cursor-pointer text-[13px] font-semibold">
            Grade tuning
          </summary>
          <p className="text-muted-ink mt-1 text-[11.5px]">
            Grade normalises the three weights whatever they hold.
          </p>
          <div className="mt-3">
            <Rows>
              {GRADE_KNOBS.map(([key, label, min, max, step]) => (
                <Row key={key} id={key}>
                  <Slider
                    label={label}
                    value={values[key] as number}
                    min={min}
                    max={max}
                    step={step}
                    onChange={(value) => void set(key, value as never)}
                  />
                </Row>
              ))}
            </Rows>
          </div>
        </details>
      )}
    </>
  );
}
