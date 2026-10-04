-- Normalized all-final regular-season boards; game results, not derived standings.
CREATE TABLE scoreboard_snapshots (
  season INTEGER NOT NULL CHECK(season BETWEEN 1920 AND 9999),
  week INTEGER NOT NULL CHECK(week BETWEEN 1 AND 18),
  scoreboard TEXT NOT NULL CHECK(json_valid(scoreboard)),
  snapshot_at TEXT NOT NULL,
  PRIMARY KEY(season, week)
);
