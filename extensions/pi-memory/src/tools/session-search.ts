/**
 * session_search tool — lets the LLM search past conversations via FTS5.
 *
 * Registered via {@link registerSessionSearch} during extension activation.
 *
 * @module pi-session-memory/tools/session-search
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { SessionStore, SearchResult } from "../store/database.ts";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Format SearchResult[] into a readable LLM-friendly string.
 */
export function formatResults(query: string, results: SearchResult[]): string {
  if (results.length === 0) {
    return `Nenhuma sessão encontrada para "${query}".`;
  }

  // Count unique sessions
  const sessionIds = new Set(results.map((r) => r.sessionId));
  const lines: string[] = [];
  lines.push(
    `🔍 Resultados para "${query}" (${sessionIds.size} ${sessionIds.size === 1 ? "sessão" : "sessões"}):\n`,
  );

  for (const r of results) {
    const date = r.date ? r.date.substring(0, 10) : "data desconhecida";
    const project = r.projectDir || "projeto desconhecido";
    const snippet = r.content
      ? r.content.length > 200
        ? r.content.substring(0, 200) + "..."
        : r.content
      : "(sem conteúdo)";

    lines.push(`📅 ${date} — ${project}`);
    lines.push(`   [${r.role}] ${snippet.replace(/\n/g, " ")}\n`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the session_search tool with the Pi ExtensionAPI.
 */
export function registerSessionSearch(pi: ExtensionAPI, store: SessionStore): void {
  pi.registerTool({
    name: "session_search",
    description:
      "Busca mensagens de conversas anteriores por palavras-chave. Útil para recuperar contexto de sessões passadas sem precisar que o usuário re-explique.",
    parameters: Type.Object({
      query: Type.String({ description: "Termos de busca (palavras-chave ou frase)" }),
      limit: Type.Optional(
        Type.Number({ default: 5, description: "Máximo de resultados (padrão: 5)" }),
      ),
      project: Type.Optional(
        Type.String({ description: "Filtrar por diretório de projeto" }),
      ),
    }),
    async execute(
      toolCallId: string,
      params: any,
      signal: any,
      onUpdate: any,
      ctx: any,
    ) {
      const results = store.searchMessages(
        params.query,
        params.limit ?? 5,
        params.project ?? undefined,
      );
      const text = formatResults(params.query, results);
      return {
        content: [{ type: "text" as const, text }],
        details: {},
      };
    },
  });
}
