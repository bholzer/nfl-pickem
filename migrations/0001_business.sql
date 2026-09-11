CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id TEXT,
  discord_username TEXT,
  admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX index_users_on_discord_user_id ON users (discord_user_id);

CREATE TABLE submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id),
  week INTEGER NOT NULL,
  picks TEXT NOT NULL DEFAULT '{}',
  tiebreaker INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX index_submissions_on_user_id_and_week ON submissions (user_id, week);
CREATE INDEX index_submissions_on_week ON submissions (week);
