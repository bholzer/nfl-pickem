-- Venmo display names the banker has seen each player use. Matching is by the
-- normalized form (trimmed, single-spaced, lowercase), which belongs to at most
-- one player so an imported payment can never match two people.
CREATE TABLE venmo_display_names (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users (id),
  -- As the banker entered it.
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
  normalized_name TEXT NOT NULL UNIQUE CHECK(length(normalized_name) > 0)
);

CREATE INDEX venmo_display_names_user ON venmo_display_names (user_id);

-- A player's Venmo @username without the `@`; only used to build pay links.
CREATE TABLE venmo_usernames (
  user_id INTEGER PRIMARY KEY REFERENCES users (id),
  username TEXT NOT NULL CHECK(length(username) BETWEEN 5 AND 30)
);

-- Lowercase note fragments; an imported payment is approved automatically only
-- when its note contains one and its counterparty is a known player.
CREATE TABLE payment_keywords (
  keyword TEXT PRIMARY KEY CHECK(keyword = lower(keyword) AND length(keyword) BETWEEN 2 AND 40)
);
