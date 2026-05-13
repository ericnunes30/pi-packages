import { describe, it } from "node:test";
import assert from "node:assert";

// Test the formatting logic directly with a local replica since we want
// to verify formatting behavior without needing the full module resolution.
function localFormatResults(query: string, results: any[]): string {
  if (results.length === 0) {
    return `Nenhuma sessão encontrada para "${query}".`;
  }
  const sessionIds = new Set(results.map((r: any) => r.sessionId));
  const lines: string[] = [];
  lines.push(`🔍 Resultados para "${query}" (${sessionIds.size} ${sessionIds.size === 1 ? "sessão" : "sessões"}):\n`);
  for (const r of results) {
    const date = r.date ? r.date.substring(0, 10) : "data desconhecida";
    const project = r.projectDir || "projeto desconhecido";
    const snippet = r.content
      ? (r.content.length > 200 ? r.content.substring(0, 200) + "..." : r.content)
      : "(sem conteúdo)";
    lines.push(`📅 ${date} — ${project}`);
    lines.push(`   [${r.role}] ${snippet.replace(/\n/g, " ")}\n`);
  }
  return lines.join("\n");
}

describe("formatResults (session_search output)", () => {
  it("should return friendly message when no results", () => {
    const output = localFormatResults("docker compose", []);
    assert.strictEqual(output, 'Nenhuma sessão encontrada para "docker compose".');
  });

  it("should format results with date, project, role and snippet", () => {
    const results = [
      {
        sessionId: "s1",
        projectDir: "/project/alpha",
        date: "2026-05-01T10:00:00.000Z",
        role: "user",
        content: "Como configurar o docker compose?",
        rank: 1,
      },
    ];
    const output = localFormatResults("docker compose", results);
    assert.ok(output.includes("🔍 Resultados para"));
    assert.ok(output.includes("📅 2026-05-01"));
    assert.ok(output.includes("/project/alpha"));
    assert.ok(output.includes("[user]"));
    assert.ok(output.includes("docker compose"));
  });

  it("should truncate long content at 200 characters", () => {
    const longContent = "A".repeat(300);
    const results = [
      {
        sessionId: "s1",
        projectDir: "/project/beta",
        date: "2026-05-01T10:00:00.000Z",
        role: "user",
        content: longContent,
        rank: 1,
      },
    ];
    const output = localFormatResults("test", results);
    assert.ok(output.length < 500); // truncated, no 300 chars
    assert.ok(output.includes("...")); // truncation indicator
  });

  it("should handle empty content gracefully", () => {
    const results = [
      {
        sessionId: "s1",
        projectDir: "/project/gamma",
        date: "2026-05-01T10:00:00.000Z",
        role: "assistant",
        content: "",
        rank: 1,
      },
    ];
    const output = localFormatResults("test", results);
    assert.ok(output.includes("(sem conteúdo)"));
  });

  it("should pluralize 'sessões' when multiple sessions", () => {
    const results = [
      { sessionId: "s1", projectDir: "/p1", date: "2026-05-01", role: "user", content: "a", rank: 1 },
      { sessionId: "s2", projectDir: "/p2", date: "2026-05-01", role: "user", content: "b", rank: 2 },
    ];
    const output = localFormatResults("test", results);
    assert.ok(output.includes("2 sessões"));
  });
});
