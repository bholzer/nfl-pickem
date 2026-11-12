-- Money actually moved between the banker and players, in whole cents. Entries
-- are never edited or deleted; a mistaken approved entry is voided instead.
CREATE TABLE payment_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL CHECK(season BETWEEN 1920 AND 9999),
  -- Null until an imported pending entry is matched to a player.
  user_id INTEGER REFERENCES users (id),
  -- `in` is paid to the banker, `out` is paid by the banker.
  direction TEXT NOT NULL CHECK(direction IN ('in', 'out')),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  source TEXT NOT NULL CHECK(source IN ('manual', 'venmo_email', 'venmo_csv', 'carryover')),
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'ignored', 'voided')),
  venmo_transaction_id TEXT,
  venmo_name TEXT,
  note TEXT,
  paid_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  voided_at TEXT,
  CHECK(status <> 'approved' OR user_id IS NOT NULL),
  CHECK((status = 'voided') = (voided_at IS NOT NULL))
);

CREATE UNIQUE INDEX payment_entries_venmo_transaction
  ON payment_entries (venmo_transaction_id)
  WHERE venmo_transaction_id IS NOT NULL;
CREATE INDEX payment_entries_season_status ON payment_entries (season, status);

-- Pool-wide settings; exactly one row once written.
CREATE TABLE pool_settings (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  banker_user_id INTEGER REFERENCES users (id),
  updated_at TEXT NOT NULL
);
