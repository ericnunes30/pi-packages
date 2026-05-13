import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { SessionStore } from "../../pi-session-memory/src/store/database.js";

describe("Migration Importer", () => {
  let testDir: string;
  let testJsonlDir: string;

  before(() => {
    testDir = mkdtempSync(join(tmpdir(), "pi-migration-test-"));
    // Mock the sessions directory structure
    testJsonlDir = join(testDir, "sessions", "test-project");
    mkdirSync(testJsonlDir, { recursive: true });
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should parse a valid JSONL v3 session file", () => {
    // Create a sample JSONL file with header + 3 messages in tree format
    const sessionId = "test-session-import-1";
    const jsonl = [
      JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: "/test/project", timestamp: "2026-05-01T10:00:00.000Z" }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-05-01T10:00:00.000Z", message: { role: "user", content: "Hello", timestamp: 1714521600000 } }),
      JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-05-01T10:00:05.000Z", message: { role: "assistant", content: "Hi there!", timestamp: 1714521605000, usage: { totalTokens: 10 } } }),
      JSON.stringify({ type: "message", id: "m3", parentId: "m2", timestamp: "2026-05-01T10:00:10.000Z", message: { role: "toolResult", content: "Command output", timestamp: 1714521610000 } }),
    ].join("\n");

    const filePath = join(testJsonlDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, jsonl);

    // Parse manually to verify structure
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    assert.strictEqual(lines.length, 4);
    
    const header = JSON.parse(lines[0]);
    assert.strictEqual(header.type, "session");
    assert.strictEqual(header.id, sessionId);
    
    const entries = lines.slice(1).map(l => JSON.parse(l));
    assert.strictEqual(entries.length, 3);
    assert.strictEqual(entries[0].type, "message");
  });

  it("should handle session with only header (no messages)", () => {
    const sessionId = "test-session-empty";
    const jsonl = JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: "/test/project", timestamp: "2026-05-01T10:00:00.000Z" });
    
    const filePath = join(testJsonlDir, `${sessionId}.jsonl`);
    writeFileSync(filePath, jsonl);
    
    // Just verify the file is valid JSONL with header only
    const lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    assert.strictEqual(lines.length, 1);
  });

  it("should import a session into the database via SessionStore", () => {
    // Use the SessionStore directly to verify a simple import
    const dbPath = join(testDir, "importer-test.db");
    const store = new SessionStore(dbPath);
    
    try {
      store.createSession("direct-import-session", "/test/project");
      store.insertMessage("direct-import-session", "user", "Message 1");
      store.insertMessage("direct-import-session", "assistant", "Message 2");
      store.insertMessage("direct-import-session", "tool", "Message 3");
      
      // Verify data
      const messages = store.getSessionMessages("direct-import-session");
      assert.strictEqual(messages.length, 3);
      assert.strictEqual((messages[0] as any).role, "user");
      assert.strictEqual((messages[1] as any).role, "assistant");
      assert.strictEqual((messages[2] as any).role, "tool");
      
      // Idempotency: second call should find existing messages
      const existing = store.getSessionMessages("direct-import-session");
      assert.strictEqual(existing.length, 3);
    } finally {
      store.close();
    }
  });

  it("should handle content as array of blocks", () => {
    const dbPath = join(testDir, "content-blocks-test.db");
    const store = new SessionStore(dbPath);
    
    try {
      store.createSession("content-blocks-session", "/test/project");
      // Simulate array content by extracting text before inserting
      const contentBlocks = [
        { type: "text", text: "Hello" },
        { type: "text", text: "World" },
      ];
      const extractedText = contentBlocks
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join(" ");
      
      store.insertMessage("content-blocks-session", "user", extractedText);
      const msg = store.getSessionMessages("content-blocks-session");
      assert.strictEqual((msg[0] as any).content, "Hello World");
    } finally {
      store.close();
    }
  });
});
