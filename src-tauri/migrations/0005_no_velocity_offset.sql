-- `velocity_offset` shifted every strike's velocity before Grade read it, to true up a keyboard
-- that read high or low. The velocity remap of 0004 does that job and more: it moves both ends of
-- the range rather than sliding the whole line, and a grade now reads the remapped velocity. The
-- offset is a weaker duplicate, so it goes rather than being left to shift a strike a second time.

DELETE FROM setting WHERE key = 'velocity_offset';
