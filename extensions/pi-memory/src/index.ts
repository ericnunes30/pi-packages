/**
 * pi-session-memory — Extension entry point + Pi event hooks.
 *
 * Connects Pi session lifecycle events (session_start, agent_end,
 * session_shutdown) to the SQLite-based SessionStore.
 *
 * @module pi-session-memory
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionStore } from "./store/database.js";
import { registerSessionSearch } from "./tools/session-search.js";
import { homedir } from "os";
import { join } from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the SQLite database path under ~/.pi/session-memory/.
 */
export function getDbPath(): string {
  return join(homedir(), ".pi", "session-memory", "memory.db");
}

/**
 * Extract plain text from an AgentMessage's `content` field.
 *
 * Supports both a plain string and the array-of-blocks format used by some
 * model providers (e.g. Anthropic).
 */
export function extractText(msg: any): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join(" ");
  }
  return "";
}

/**
 * Map Pi-internal roles to the canonical SQL roles.
 *
 * @see Role-mapping table in spec
 */
export function mapRole(role: string): string {
  switch (role) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
    case "bashExecution":
      return "tool";
    default:
      return "tool"; // fallback
  }
}

// ---------------------------------------------------------------------------
// Extension activation
// ---------------------------------------------------------------------------

export default function activate(pi: ExtensionAPI): void {
  const store = new SessionStore(getDbPath());

  // Register tools
  registerSessionSearch(pi, store);

  // -----------------------------------------------------------------------
  // session_start — create session record, load branch history on resume
  // -----------------------------------------------------------------------
  pi.on("session_start", (event: any, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const cwd = ctx.sessionManager.getCwd();
    const model = ctx.model?.id;

    store.createSession(sessionId, cwd, model);

    // On resume/fork, load existing branch messages into the store so they
    // become part of the searchable history.
    try {
      const branch = ctx.sessionManager.getBranch();
      if (branch && branch.length > 0) {
        for (const entry of branch) {
          if (entry.type === "message" && entry.message) {
            const msg: any = entry.message;
            store.insertMessage(
              sessionId,
              mapRole(msg.role),
              extractText(msg),
              undefined, // toolName
              undefined, // toolArgs
              undefined, // tokenCount
              typeof msg.timestamp === "number"
                ? new Date(msg.timestamp).toISOString()
                : msg.timestamp,
            );
          }
        }
      }
    } catch (err) {
      console.warn("[pi-session-memory] Error loading branch history:", err);
    }
  });

  // -----------------------------------------------------------------------
  // agent_end — persist every assistant turn
  // -----------------------------------------------------------------------
  pi.on("agent_end", (event: any, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const messages: any[] = event.messages ?? [];

    for (const msg of messages) {
      const role = msg.role;

      // Skip non-standard roles (custom metadata, summary entries)
      if (
        role === "custom" ||
        role === "branchSummary" ||
        role === "compactionSummary"
      ) {
        continue;
      }

      store.bufferMessage(
        sessionId,
        mapRole(role),
        extractText(msg),
        msg.timestamp ?? Date.now(),
        msg.usage?.totalTokens ?? undefined,
      );
    }

    store.flush(sessionId);
  });

  // -----------------------------------------------------------------------
  // session_shutdown — finalise session, flush buffers, close DB
  // -----------------------------------------------------------------------
  pi.on("session_shutdown", (event: any, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    try {
      store.flush(sessionId);
      store.endSession(sessionId);
    } finally {
      store.close();
    }
  });
}
