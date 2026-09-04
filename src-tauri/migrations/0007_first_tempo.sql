-- The BPM of the piece's first tempo mark, the number the facts row prints. NULL is a file that
-- names no tempo at all.
ALTER TABLE piece ADD COLUMN tempo_bpm REAL;

-- An mtime no file carries, so the next scan plans every row indexed before the column and reads
-- the number out of the file once.
UPDATE piece SET mtime = -1;
