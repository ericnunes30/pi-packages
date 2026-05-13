/**
 * pi-session-migration — CLI importer
 *
 * Reads all existing JSONL session files from ~/.pi/agent/sessions/
 * and imports them into the pi-session-memory SQLite database.
 *
 * Usage: node src/importer.ts
 *        npx tsx src/importer.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionStore } from "../../pi-session-memory/src/store/database.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Header line — always the first line of every JSONL session file. */
interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
  [key: string]: unknown;
}

/** A single entry from a JSONL file (one JSON object per line). */
interface JsonlEntry {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  message?: {
    role: string;
    content: string | unknown[];
    timestamp?: number | string;
    toolName?: string;
    toolArgs?: unknown;
    usage?: {
      totalTokens?: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract plain text from a message `content` field.
 *
 * Supports both a plain string and the array-of-blocks format (e.g. Anthropic
 * / Open AI completions).
 */
function extractText(content: string | unknown[]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((b) => b.type === "text")
      .map((b) => String(b.text ?? ""))
      .join(" ");
  }
  return "";
}

/**
 * Map Pi-internal roles to canonical SQL roles.
 *
 * - "toolResult" → "tool"  (mirrors the mapping in pi-session-memory/src/index.ts)
 * - Everything else maps through unchanged.
 */
function mapRole(role: string): string {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
    case "bashExecution":
      return "tool";
    default:
      return "tool";
  }
}

/**
 * Resolve the database path so we import into the same DB that the
 * pi-session-memory extension uses.
 */
function getDbPath(): string {
  return join(homedir(), ".pi", "session-memory", "memory.db");
}

// ---------------------------------------------------------------------------
// JSONL parser
// ---------------------------------------------------------------------------

/**
 * Parse a single JSONL file into a header + ordered list of message payloads
 * ready for insertion.
 *
 * Steps
 * -----
 * 1. Read all lines, split by newline, discard empties.
 * 2. First line → header (session metadata).
 * 3. Remaining lines → entries; build a Map<id, entry>.
 * 4. Build a children Map<parentId, child[]>
 * 5. Find root entry (parentId === null/undefined, or first entry, or header).
 * 6. DFS walk from root to produce a flat ordered list.
 * 7. Yield only entries where type === "message", extracting the fields
 *    needed for insertMessage().
 */
function parseSessionFile(
  filePath: string,
): { header: SessionHeader; messages: MessagePayload[] } | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    return null;
  }

  const lines = content.split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  // ---- 1. Parse header ---------------------------------------------------
  let header: SessionHeader;
  try {
    header = JSON.parse(lines[0]) as SessionHeader;
  } catch {
    return null;
  }
  if (header.type !== "session") return null;

  // ---- 2. Parse remaining entries ----------------------------------------
  const entries: JsonlEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]) as JsonlEntry;
      if (entry && typeof entry.id === "string") {
        entries.push(entry);
      }
    } catch {
      // skip malformed lines
    }
  }

  if (entries.length === 0) {
    // Only a header, no messages → still valid, create empty session
    return { header, messages: [] };
  }

  // ---- 3. Build id → entry map -------------------------------------------
  const entryMap = new Map<string, JsonlEntry>();
  for (const entry of entries) {
    entryMap.set(entry.id, entry);
  }

  // ---- 4. Build parentId → children map ----------------------------------
  const childrenMap = new Map<string | null, JsonlEntry[]>();
  for (const entry of entries) {
    const pid = entry.parentId ?? null;
    const list = childrenMap.get(pid) ?? [];
    list.push(entry);
    childrenMap.set(pid, list);
  }

  // ---- 5. Find root entry ------------------------------------------------
  let root: JsonlEntry | null = null;

  // Prefer an entry with parentId === null | undefined
  for (const entry of entries) {
    if (entry.parentId === null || entry.parentId === undefined) {
      root = entry;
      break;
    }
  }

  // Fallback: use the first entry
  if (!root && entries.length > 0) {
    root = entries[0];
  }

  if (!root) {
    return { header, messages: [] };
  }

  // ---- 6. DFS traversal to build ordered list ----------------------------
  const orderedEntries: JsonlEntry[] = [];

  function walk(node: JsonlEntry): void {
    orderedEntries.push(node);
    const children = childrenMap.get(node.id);
    if (children) {
      for (const child of children) {
        walk(child);
      }
    }
  }

  walk(root);

  // ---- 7. Extract message payloads ---------------------------------------
  const messages: MessagePayload[] = [];
  for (const entry of orderedEntries) {
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;

    messages.push({
      role: mapRole(msg.role),
      content: extractText(msg.content),
      timestamp:
        typeof msg.timestamp === "number"
          ? new Date(msg.timestamp).toISOString()
          : msg.timestamp ?? entry.timestamp ?? new Date().toISOString(),
      toolName: msg.toolName ?? undefined,
      toolArgs:
        msg.toolArgs !== undefined
          ? JSON.stringify(msg.toolArgs)
          : undefined,
      tokenCount: msg.usage?.totalTokens ?? undefined,
    });
  }

  return { header, messages };
}

/** Extracted message payload ready for insertMessage(). */
interface MessagePayload {
  role: string;
  content: string;
  timestamp: string;
  toolName?: string;
  toolArgs?: string;
  tokenCount?: number;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const startTime = Date.now();

  const sessionsDir = join(homedir(), ".pi", "agent", "sessions");

  // ---- Scan for .jsonl files ---------------------------------------------
  let jsonlFiles: string[] = [];
  try {
    const entries = readdirSync(sessionsDir, { recursive: true });
    for (const entry of entries) {
      const name = String(entry);
      if (name.endsWith(".jsonl")) {
        jsonlFiles.push(resolve(sessionsDir, name));
      }
    }
  } catch (err) {
    process.stderr.write(
      `[ERROR] Cannot read sessions directory "${sessionsDir}": ${err}\n`,
    );
    process.exit(1);
  }

  const totalSessions = jsonlFiles.length;
  if (totalSessions === 0) {
    console.log("=== Migration Report ===");
    console.log("No JSONL session files found.");
    return;
  }

  // ---- Open store --------------------------------------------------------
  const dbPath = getDbPath();
  process.stderr.write(`Database: ${dbPath}\n`);
  const store = new SessionStore(dbPath);

  let newSessions = 0;
  let skippedSessions = 0;
  let totalMessages = 0;
  let errors = 0;

  // ---- Process in groups of 50 -------------------------------------------
  const batchSize = 50;
  let processedCount = 0;

  for (let i = 0; i < totalSessions; i += batchSize) {
    const batchEnd = Math.min(i + batchSize, totalSessions);
    const batchFiles = jsonlFiles.slice(i, batchEnd);

    for (const filePath of batchFiles) {
      processedCount++;
      const percent = ((processedCount / totalSessions) * 100).toFixed(0);
      const shortName = filePath.startsWith(sessionsDir)
        ? filePath.slice(sessionsDir.length).replace(/^[\\/]/, "")
        : filePath;

      process.stderr.write(
        `[${processedCount}/${totalSessions}] Importing ${shortName} (${percent}%)\n`,
      );

      try {
        const result = parseSessionFile(filePath);
        if (!result) {
          errors++;
          process.stderr.write(`  [ERROR] ${filePath}: Failed to parse (invalid or empty JSONL)\n`);
          continue;
        }

        const { header, messages } = result;
        const sessionId = header.id;
        const projectDir = header.cwd;

        // ---- Idempotency check -------------------------------------------
        const existing = store.getSessionMessages(sessionId);
        if (existing.length > 0) {
          skippedSessions++;
          continue;
        }

        // ---- Create session + insert messages ----------------------------
        store.createSession(sessionId, projectDir);

        for (const msg of messages) {
          store.insertMessage(
            sessionId,
            msg.role,
            msg.content,
            msg.toolName,
            msg.toolArgs,
            msg.tokenCount,
            msg.timestamp,
          );
        }

        newSessions++;
        totalMessages += messages.length;
      } catch (err) {
        errors++;
        process.stderr.write(
          `  [ERROR] ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  store.close();

  // ---- Final report to stdout --------------------------------------------
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("=== Migration Report ===");
  console.log(`Total sessions: ${totalSessions}`);
  console.log(`New sessions imported: ${newSessions}`);
  console.log(`Already existed (skipped): ${skippedSessions}`);
  console.log(`Total messages: ${totalMessages}`);
  console.log(`Errors: ${errors}`);
  console.log(`Duration: ${duration}s`);
}

// ---- Entry point detection ------------------------------------------------
const scriptPath = fileURLToPath(import.meta.url);
const invokedPath = typeof process.argv[1] === "string" ? resolve(process.argv[1]) : "";
if (scriptPath === invokedPath) {
  main();
}
