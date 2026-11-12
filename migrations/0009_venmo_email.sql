-- Venmo payment emails that reached the inbox but could not be read, kept so
-- the banker can import the payment another way. Only the truncated subject
-- and a reason are stored: never the body, the note, or any address.
CREATE TABLE venmo_email_failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  subject TEXT NOT NULL CHECK(length(subject) <= 200),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 200),
  dismissed_at TEXT
);

CREATE INDEX venmo_email_failures_open
  ON venmo_email_failures (received_at)
  WHERE dismissed_at IS NULL;
