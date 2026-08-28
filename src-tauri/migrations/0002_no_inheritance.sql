-- Inheritance goes. A piece's tempo, hands, metronome and count-in are set on the play toolbar and
-- fall back to the built-in default, never to a global one, so the seven `default_*` keys go too.

-- Keyboard size stops being a piece setting and becomes one global row, so the default the user
-- chose is the value that row opens on. Renaming keeps the JSON, and the three new keys are free.
UPDATE setting SET key = 'keyboard_preset' WHERE key = 'default_keyboard_preset';
UPDATE setting SET key = 'keyboard_lo' WHERE key = 'default_keyboard_lo';
UPDATE setting SET key = 'keyboard_hi' WHERE key = 'default_keyboard_hi';

DELETE FROM setting
WHERE key IN ('default_tempo_value', 'default_metronome', 'default_count_in_bars', 'default_hands');

ALTER TABLE piece DROP COLUMN keyboard_preset;
ALTER TABLE piece DROP COLUMN keyboard_lo;
ALTER TABLE piece DROP COLUMN keyboard_hi;
