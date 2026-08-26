CREATE TABLE piece (
  path            TEXT PRIMARY KEY,

  title           TEXT,
  composer        TEXT,
  measure_count   INTEGER,
  duration_s      REAL,
  midi_lo         INTEGER,
  midi_hi         INTEGER,
  has_tempo       INTEGER,
  constant_tempo  INTEGER,
  key_sharps      INTEGER,
  key_mode        TEXT,
  part_count      INTEGER,
  part_name       TEXT,

  mtime           INTEGER NOT NULL,
  size            INTEGER NOT NULL,
  present         INTEGER NOT NULL DEFAULT 1,
  imported_at     INTEGER NOT NULL,

  favorite        INTEGER NOT NULL DEFAULT 0,
  error           TEXT,

  -- Piece settings. NULL means the piece inherits the global default.
  tempo_mode      TEXT,
  tempo_value     REAL,
  metronome       INTEGER,
  count_in_bars   INTEGER,
  hands           TEXT,
  keyboard_preset TEXT,
  keyboard_lo     INTEGER,
  keyboard_hi     INTEGER
);

CREATE TABLE play (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  piece_path    TEXT NOT NULL REFERENCES piece(path) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('practice', 'performance')),
  started_at    INTEGER NOT NULL,
  duration_s    REAL NOT NULL,

  -- Performance rows only: the settings the run resolved to, then its grade.
  tempo_mode    TEXT,
  tempo_value   REAL,
  hands         TEXT,
  grade         REAL,
  expected      INTEGER,
  matched       INTEGER,
  extras        INTEGER,
  mean_timing   REAL,
  mean_velocity REAL,
  mean_release  REAL
);

CREATE INDEX play_piece_path ON play(piece_path);

-- Every value is JSON, so a setting may hold a number, a string, a boolean or null.
CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
