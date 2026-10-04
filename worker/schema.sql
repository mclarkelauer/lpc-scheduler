-- One row per registered user. Both keys are random and unguessable.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,      -- private key: whoever has it can read and change the picks
  feed       TEXT NOT NULL UNIQUE,  -- read-only key, the only one that appears in the calendar URL
  created_at INTEGER NOT NULL,      -- milliseconds since the epoch
  updated_at INTEGER NOT NULL
);

-- The sessions each user has starred.
CREATE TABLE IF NOT EXISTS picks (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,         -- a session id from the schedule page
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
