-- The velocity curve stops being a loudness shaper and becomes a remap from the velocity the
-- keyboard sends to the velocity the whole app works in. `velocity_floor`, the softest note's
-- volume as a percent of full, becomes `velocity_min`, an output velocity between 1 and 127. The
-- arithmetic is the one `floor_velocity` used, so a user's calibration comes across unchanged.
--
-- `velocity_max` is left alone: nothing stored one, and its default is 127, which is what the old
-- mapping's hard end already was.

INSERT INTO setting (key, value)
SELECT 'velocity_min', CAST(1 + (126 * MIN(CAST(value AS INTEGER), 100) + 50) / 100 AS TEXT)
FROM setting
WHERE key = 'velocity_floor';

DELETE FROM setting WHERE key = 'velocity_floor';
