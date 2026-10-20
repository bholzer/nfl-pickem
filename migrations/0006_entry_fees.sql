-- Per-week pool entry fee in whole cents; a missing row means the application default.
CREATE TABLE week_entry_fees (
  season INTEGER NOT NULL CHECK(season BETWEEN 1920 AND 9999),
  week INTEGER NOT NULL CHECK(week BETWEEN 1 AND 18),
  fee_cents INTEGER NOT NULL CHECK(fee_cents >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(season, week)
);
