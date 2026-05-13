/**
 * Schema DDL for pi-session-memory SQLite store.
 *
 * Uses FTS5 for full-text search with porter stemmer + unicode61 tokenizer.
 * Triggers keep messages_fts in sync with messages table automatically.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL: string = `
PRAGMA user_version = 1;

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_dir TEXT,
  model TEXT,
  title TEXT,
  message_count INTEGER DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  role TEXT NOT NULL,           -- user | assistant | tool
  content TEXT,
  tool_name TEXT,
  tool_args TEXT,               -- JSON string
  token_count INTEGER,
  timestamp TEXT NOT NULL,
  seq INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  tokenize="porter unicode61"
);

CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
`;
