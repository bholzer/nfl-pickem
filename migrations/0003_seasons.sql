-- Paused native instances retain their old code; cancel/terminate them first.
CREATE TABLE season_migration_guard (
  retired INTEGER NOT NULL CONSTRAINT retire_old_workflow_instances CHECK(retired = 1)
);
INSERT INTO season_migration_guard
SELECT NOT EXISTS (
  SELECT 1 FROM job_runs
  WHERE status NOT IN ('complete', 'errored', 'cancelled', 'superseded', 'creation_failed')
);
DROP TABLE season_migration_guard;

PRAGMA defer_foreign_keys = ON;

-- Preserve the AUTOINCREMENT high-water mark, including deleted submissions.
CREATE TABLE season_migration_sequence (seq INTEGER NOT NULL);
INSERT INTO season_migration_sequence SELECT seq FROM sqlite_sequence WHERE name = 'submissions';

CREATE TABLE submissions_seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id),
  season INTEGER NOT NULL CHECK(season BETWEEN 1920 AND 9999),
  week INTEGER NOT NULL,
  picks TEXT NOT NULL DEFAULT '{}',
  tiebreaker INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO submissions_seasons (id, user_id, season, week, picks, tiebreaker, created_at, updated_at)
SELECT id, user_id,
  CAST(strftime('%Y', created_at) AS INTEGER) - CASE WHEN strftime('%m', created_at) IN ('01', '02') THEN 1 ELSE 0 END,
  week, picks, tiebreaker, created_at, updated_at
FROM submissions;
DROP TABLE submissions;
ALTER TABLE submissions_seasons RENAME TO submissions;
INSERT INTO sqlite_sequence(name, seq)
SELECT 'submissions', MAX(seq) FROM season_migration_sequence
HAVING MAX(seq) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'submissions');
UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT MAX(seq) FROM season_migration_sequence), 0)) WHERE name = 'submissions';
DROP TABLE season_migration_sequence;
CREATE UNIQUE INDEX index_submissions_on_user_id_and_season_and_week ON submissions (user_id, season, week);
CREATE INDEX index_submissions_on_season_and_week ON submissions (season, week);

-- Keep references pointed at the final name while foreign-key checks are deferred.
CREATE TABLE job_runs_seasons (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('deliver_submission_links','deliver_standings','deliver_hashes','schedule_hash_delivery')),
  season INTEGER NOT NULL CHECK(season BETWEEN 1920 AND 9999),
  week INTEGER,
  params TEXT NOT NULL CHECK(json_valid(params)),
  source TEXT NOT NULL CHECK(source IN ('manual','scheduled')),
  status TEXT NOT NULL,
  planned_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT,
  delivery_scope TEXT NOT NULL,
  parent_id TEXT REFERENCES job_runs(id),
  control TEXT,
  gate_paused INTEGER NOT NULL DEFAULT 0 CHECK(gate_paused IN (0,1)),
  control_until INTEGER
);
INSERT INTO job_runs_seasons (
  id, type, season, week, params, source, status, planned_at, started_at, finished_at,
  created_at, updated_at, error, delivery_scope, parent_id, control, gate_paused, control_until
)
SELECT id, type,
  CAST(strftime('%Y', created_at) AS INTEGER) - CASE WHEN strftime('%m', created_at) IN ('01', '02') THEN 1 ELSE 0 END,
  week,
  json_set(params,
    '$.season', CAST(strftime('%Y', created_at) AS INTEGER) - CASE WHEN strftime('%m', created_at) IN ('01', '02') THEN 1 ELSE 0 END,
    '$.week', COALESCE(week, json_extract(params, '$.week'))),
  source, status, planned_at, started_at, finished_at, created_at, updated_at,
  error, delivery_scope, parent_id, control, gate_paused, control_until
FROM job_runs;
DROP TABLE job_runs;
ALTER TABLE job_runs_seasons RENAME TO job_runs;
CREATE INDEX job_runs_history ON job_runs(created_at DESC, id DESC);
CREATE INDEX job_runs_filters ON job_runs(type, status, created_at DESC);
CREATE UNIQUE INDEX job_runs_replacement ON job_runs(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX job_runs_season_history ON job_runs(season, created_at DESC, id DESC);

-- Yearless, expiring delivery caches cannot safely suppress a season-specific run.
UPDATE job_effects SET expires_at = 0 WHERE key GLOB 'standings:[0-9]*:*';
UPDATE job_markers SET expires_at = 0 WHERE key GLOB 'standings:[0-9]*:*';
UPDATE job_messages SET expires_at = 0 WHERE key GLOB 'standings:[0-9]*:*';

PRAGMA defer_foreign_keys = OFF;
