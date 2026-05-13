/**
 * SessionStore — SQLite+FTS5 persistence layer for pi-session-memory.
 *
 * Uses Node 22+ built-in `node:sqlite` (DatabaseSync).
 * All operations are synchronous.  Zero external dependencies.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SCHEMA_SQL } from './schema.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MessageBufferEntry {
  role: string;
  content: string;
  toolName?: string;
  toolArgs?: string;
  tokenCount?: number;
  timestamp: string;
}

export interface SearchResult {
  sessionId: string;
  projectDir: string;
  date: string;
  role: string;
  content: string;
  rank: number;
}

export interface Stats {
  sessions: number;
  messages: number;
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export class SessionStore {
  private db: DatabaseSync;
  private buffer: Map<string, MessageBufferEntry[]> = new Map();
  private bufferLimit: number;

  // Prepared statements (initialised lazily in constructor)
  private stmtCreateSession!: ReturnType<DatabaseSync['prepare']>;
  private stmtEndSession!: ReturnType<DatabaseSync['prepare']>;
  private stmtInsertMessage!: ReturnType<DatabaseSync['prepare']>;
  private stmtUpdateMessageCount!: ReturnType<DatabaseSync['prepare']>;
  private stmtLastInsertRowid!: ReturnType<DatabaseSync['prepare']>;
  private stmtMessages!: ReturnType<DatabaseSync['prepare']>;
  private stmtStatsSessions!: ReturnType<DatabaseSync['prepare']>;
  private stmtStatsMessages!: ReturnType<DatabaseSync['prepare']>;

  /**
   * @param dbPath  Absolute or relative path to the SQLite file.
   * @param bufferLimit  Max buffered messages per session before auto-flush.
   */
  constructor(dbPath: string, bufferLimit: number = 50) {
    this.bufferLimit = bufferLimit;

    // Ensure parent directory exists
    const absPath = resolve(dbPath);
    const dir = dirname(absPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Open database
    this.db = new DatabaseSync(absPath);

    // WAL mode + busy timeout
    this.db.exec('PRAGMA journal_mode = wal');
    this.db.exec('PRAGMA busy_timeout = 5000');

    // Run schema migration
    this.db.exec(SCHEMA_SQL);

    // Prepare statements
    this.prepareStatements();
  }

  // -----------------------------------------------------------------------
  // Prepared statement setup
  // -----------------------------------------------------------------------

  private prepareStatements(): void {
    this.stmtCreateSession = this.db.prepare(
      `INSERT INTO sessions (id, project_dir, model, started_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         project_dir = excluded.project_dir,
         model = COALESCE(excluded.model, sessions.model)`
    );

    this.stmtEndSession = this.db.prepare(
      'UPDATE sessions SET ended_at = datetime(\'now\') WHERE id = ?'
    );

    this.stmtInsertMessage = this.db.prepare(
      `INSERT INTO messages (session_id, role, content, tool_name, tool_args, token_count, timestamp, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE session_id = ?))`
    );

    this.stmtUpdateMessageCount = this.db.prepare(
      'UPDATE sessions SET message_count = message_count + 1 WHERE id = ?'
    );

    this.stmtMessages = this.db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC'
    );

    this.stmtLastInsertRowid = this.db.prepare('SELECT last_insert_rowid() AS id');

    this.stmtStatsSessions = this.db.prepare('SELECT COUNT(*) AS cnt FROM sessions');
    this.stmtStatsMessages = this.db.prepare('SELECT COUNT(*) AS cnt FROM messages');
  }

  // -----------------------------------------------------------------------
  // Session lifecycle
  // -----------------------------------------------------------------------

  createSession(id: string, projectDir: string, model?: string): void {
    this.stmtCreateSession.run(id, projectDir, model ?? null);
  }

  endSession(id: string): void {
    this.stmtEndSession.run(id);
  }

  // -----------------------------------------------------------------------
  // Message management
  // -----------------------------------------------------------------------

  /**
   * Insert a single message and update the session message_count cache.
   * Returns the new message id (last_insert_rowid).
   */
  insertMessage(
    sessionId: string,
    role: string,
    content: string,
    toolName?: string,
    toolArgs?: string,
    tokenCount?: number,
    timestamp?: string,
  ): number {
    const ts = timestamp ?? new Date().toISOString();
    this.stmtInsertMessage.run(
      sessionId,
      role,
      content ?? null,
      toolName ?? null,
      toolArgs ?? null,
      tokenCount ?? null,
      ts,
      sessionId, // seq sub-query parameter
    );
    this.stmtUpdateMessageCount.run(sessionId);
    return Number((this.stmtLastInsertRowid.get() as { id: number }).id);
  }

  /**
   * Add a message to the in-memory buffer.
   * When the buffer for a session exceeds `bufferLimit`, it is flushed
   * automatically.
   *
   * @param timestamp  Unix ms number **or** ISO 8601 string.
   */
  bufferMessage(
    sessionId: string,
    role: string,
    content: string,
    timestamp?: number | string,
    tokenCount?: number,
  ): void {
    const ts = timestamp == null
      ? new Date().toISOString()
      : typeof timestamp === 'number'
        ? new Date(timestamp).toISOString()
        : timestamp;

    const entry: MessageBufferEntry = {
      role,
      content,
      timestamp: ts,
      tokenCount,
    };

    const entries = this.buffer.get(sessionId) ?? [];
    entries.push(entry);
    this.buffer.set(sessionId, entries);

    if (entries.length >= this.bufferLimit) {
      this.flush(sessionId);
    }
  }

  /**
   * Flush all buffered messages for a session to the database inside a
   * single explicit transaction.
   */
  flush(sessionId: string): void {
    const entries = this.buffer.get(sessionId);
    if (!entries || entries.length === 0) return;

    this.db.exec('BEGIN');

    try {
      for (const entry of entries) {
        this.stmtInsertMessage.run(
          sessionId,
          entry.role,
          entry.content ?? null,
          entry.toolName ?? null,
          entry.toolArgs ?? null,
          entry.tokenCount ?? null,
          entry.timestamp ?? new Date().toISOString(),
          sessionId,
        );
        this.stmtUpdateMessageCount.run(sessionId);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    // Only clear buffer on successful commit
    this.buffer.delete(sessionId);
  }

  // -----------------------------------------------------------------------
  // Full-text search (FTS5 with LIKE fallback)
  // -----------------------------------------------------------------------

  /**
   * Search messages using FTS5.  Falls back to LIKE when the FTS5 query
   * is invalid (e.g. syntax error from user-supplied input).
   *
   * Returns an ordered array of SearchResult (empty array if no matches).
   */
  searchMessages(
    query: string,
    limit: number = 10,
    projectDir?: string,
  ): SearchResult[] {
    // ---- attempt FTS5 first ------------------------------------------------
    try {
      return this.ftsSearch(query, limit, projectDir);
    } catch {
      // FTS5 failed — fallback to LIKE
      return this.likeSearch(query, limit, projectDir);
    }
  }

  private ftsSearch(
    query: string,
    limit: number,
    projectDir?: string,
  ): SearchResult[] {
    let sql: string;
    const params: unknown[] = [];

    if (projectDir) {
      sql = `
        SELECT m.session_id AS sessionId,
               s.project_dir AS projectDir,
               m.timestamp AS date,
               m.role,
               m.content,
               rank
        FROM messages_fts
        JOIN messages m ON messages_fts.rowid = m.id
        JOIN sessions s ON m.session_id = s.id
        WHERE messages_fts MATCH ?
          AND s.project_dir = ?
        ORDER BY rank
        LIMIT ?
      `;
      params.push(query, projectDir, limit);
    } else {
      sql = `
        SELECT m.session_id AS sessionId,
               s.project_dir AS projectDir,
               m.timestamp AS date,
               m.role,
               m.content,
               rank
        FROM messages_fts
        JOIN messages m ON messages_fts.rowid = m.id
        JOIN sessions s ON m.session_id = s.id
        WHERE messages_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `;
      params.push(query, limit);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as SearchResult[];
    return rows;
  }

  private likeSearch(
    query: string,
    limit: number,
    projectDir?: string,
  ): SearchResult[] {
    let sql: string;
    const params: unknown[] = [];

    if (projectDir) {
      sql = `
        SELECT m.session_id AS sessionId,
               s.project_dir AS projectDir,
               m.timestamp AS date,
               m.role,
               m.content,
               0 AS rank
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE m.content LIKE '%' || ? || '%'
          AND s.project_dir = ?
        ORDER BY m.timestamp DESC
        LIMIT ?
      `;
      params.push(query, projectDir, limit);
    } else {
      sql = `
        SELECT m.session_id AS sessionId,
               s.project_dir AS projectDir,
               m.timestamp AS date,
               m.role,
               m.content,
               0 AS rank
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE m.content LIKE '%' || ? || '%'
        ORDER BY m.timestamp DESC
        LIMIT ?
      `;
      params.push(query, limit);
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as SearchResult[];
    return rows;
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /** Return all messages for a session ordered by sequence number. */
  getSessionMessages(sessionId: string): Record<string, unknown>[] {
    return this.stmtMessages.all(sessionId) as Record<string, unknown>[];
  }

  /** Return total count of sessions and messages. */
  getStats(): Stats {
    const sessionsRow = this.stmtStatsSessions.get() as { cnt: number };
    const messagesRow = this.stmtStatsMessages.get() as { cnt: number };
    return {
      sessions: sessionsRow.cnt,
      messages: messagesRow.cnt,
    };
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Flush all pending buffers and close the database connection.
   * Safe to call multiple times.
   */
  close(): void {
    // Flush every session that still has buffered messages
    for (const sessionId of this.buffer.keys()) {
      this.flush(sessionId);
    }
    this.db.close();
  }
}
