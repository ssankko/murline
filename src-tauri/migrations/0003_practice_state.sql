-- Flow/wait, the Section and Loop stop dying with the screen. They become piece columns like tempo
-- and hands, so a piece reopens in the practice setup it was left in. NULL in any of them is a
-- piece that has never been given that one, which opens in flow, with no Section and Loop off.

ALTER TABLE piece ADD COLUMN mode TEXT;
ALTER TABLE piece ADD COLUMN loop INTEGER;
-- The Section as measure indices, both ends inside it. Either one NULL is no Section.
ALTER TABLE piece ADD COLUMN section_from INTEGER;
ALTER TABLE piece ADD COLUMN section_to INTEGER;
