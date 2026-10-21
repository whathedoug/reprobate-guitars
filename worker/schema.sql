-- Guestbook table. Already created in the "reprobate-guestbook" D1 database; kept here for reference.
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  location TEXT,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ip_hash TEXT NOT NULL,
  del_token TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_created ON entries(created_at);
CREATE INDEX IF NOT EXISTS idx_entries_ip ON entries(ip_hash, created_at);
