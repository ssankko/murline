-- The place a practice was left stops dying with the screen: the played tick the cursor stood at,
-- the same number a seek takes. NULL is a piece never practised, which opens at its start.

ALTER TABLE piece ADD COLUMN position_tick INTEGER;
