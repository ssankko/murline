// The settings panel's Playing tab: the timing windows a strike is judged by, the inactive hand,
// and in a dev build the knobs that shape a Grade.

import { Row, Rows, Segmented, Slider, Toggle } from "@/look/rows";
import { INACTIVE_HAND_LEVEL, type InactiveHandVelocity } from "@/play/settings";
import { bind, Section } from "@/settings/controls";
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
          <Slider
            id="matching_window_ms"
            hint="How far off the beat a strike still counts."
            unit=" ms"
            min={1}
            max={1000}
            {...bind(values, "matching_window_ms")}
          />
          <Slider
            id="togetherness_ms"
            hint="How far apart the notes of one chord may be struck."
            unit=" ms"
            min={1}
            max={1000}
            {...bind(values, "togetherness_ms")}
          />
        </Rows>
      </Section>

      {/* The velocity and the level shape a sound nothing makes while the first row is
        off, so both stand dead until it is on. */}
      <Section title="Inactive hand">
        <Rows>
          <Row
            id="play_inactive_hand"
            hint="The app plays the hand you are not practising."
          >
            <Toggle {...bind(values, "play_inactive_hand")} />
          </Row>
          <Row
            id="play_inactive_hand_velocity"
            hint="Whether that hand takes its loudness from the score or from how hard you play."
          >
            <Segmented
              options={INACTIVE_HAND_VELOCITIES}
              disabled={!values.play_inactive_hand}
              {...bind(values, "play_inactive_hand_velocity")}
            />
          </Row>
          <Slider
            id="play_inactive_hand_level"
            hint="How loud that hand plays."
            unit="%"
            min={INACTIVE_HAND_LEVEL[0]}
            max={INACTIVE_HAND_LEVEL[1]}
            step={5}
            disabled={!values.play_inactive_hand}
            {...bind(values, "play_inactive_hand_level")}
          />
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
              {GRADE_KNOBS.map(([key, , min, max, step]) => (
                <Slider
                  key={key}
                  id={key}
                  value={values[key] as number}
                  min={min}
                  max={max}
                  step={step}
                  onChange={(value) => void set(key, value as never)}
                />
              ))}
            </Rows>
          </div>
        </details>
      )}
    </>
  );
}
