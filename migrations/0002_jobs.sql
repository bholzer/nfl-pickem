CREATE TABLE job_runs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('deliver_submission_links','deliver_standings','deliver_hashes','schedule_hash_delivery')),
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
CREATE INDEX job_runs_history ON job_runs(created_at DESC, id DESC);
CREATE INDEX job_runs_filters ON job_runs(type, status, created_at DESC);
CREATE UNIQUE INDEX job_runs_replacement ON job_runs(parent_id) WHERE parent_id IS NOT NULL;
CREATE TABLE job_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN (0,1))
);
INSERT INTO job_settings(id, paused) VALUES (1, 0);
CREATE TABLE job_deliveries (
  run_id TEXT NOT NULL REFERENCES job_runs(id),
  key TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(run_id, key)
);
CREATE TABLE job_effects (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sending','sent')),
  lease_until INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE job_markers (
  key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE job_messages (
  key TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
