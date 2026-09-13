CREATE TABLE hash_publications (
  snapshot_key TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  season INTEGER NOT NULL CHECK(season BETWEEN 1920 AND 9999),
  week INTEGER NOT NULL CHECK(week BETWEEN 1 AND 18),
  channel_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  snapshot_at TEXT NOT NULL
);

CREATE TABLE hash_receipts (
  id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES hash_publications(id),
  submission_id INTEGER NOT NULL,
  username TEXT,
  summary TEXT NOT NULL,
  verification_hash TEXT NOT NULL,
  game_ids TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK(part_index >= 0),
  UNIQUE(publication_id, submission_id)
);
CREATE INDEX hash_receipts_submission ON hash_receipts(submission_id, publication_id);

CREATE TABLE hash_publication_parts (
  publication_id TEXT NOT NULL REFERENCES hash_publications(id),
  part_index INTEGER NOT NULL CHECK(part_index >= 0),
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  published_at TEXT NOT NULL,
  PRIMARY KEY(publication_id, part_index)
);
