-- One row per registered user. Both keys are random and unguessable.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,      -- private key: whoever has it can read and change the picks
  feed       TEXT NOT NULL UNIQUE,  -- read-only key, the only one that appears in the calendar URL
  created_at INTEGER NOT NULL,      -- milliseconds since the epoch
  updated_at INTEGER NOT NULL
);

-- The sessions each user has flagged.
CREATE TABLE IF NOT EXISTS picks (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,         -- a session id from the schedule page
  added_at   INTEGER NOT NULL,
  level      INTEGER NOT NULL DEFAULT 2,  -- 1 = interested, 2 = attending (which implies interested)
  PRIMARY KEY (user_id, session_id)
);
-- A database created before levels existed needs, once:
--   ALTER TABLE picks ADD COLUMN level INTEGER NOT NULL DEFAULT 2;
