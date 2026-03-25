#!/usr/bin/env node
/**
 * Local MCP server for knowledge and memory search.
 *
 * Exposes three tools the OpenCode agent can call on demand:
 *   - search_knowledge: semantic search across S3-synced knowledge files
 *   - recall_memories: semantic search across saved memories
 *   - save_memory: save new memories (conventions, corrections, decisions)
 *
 * Uses LanceDB for vector search and a local embedding model
 * (all-MiniLM-L6-v2) so no external API calls are needed.
 *
 * Runs as a stdio-based MCP server spawned by OpenCode.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import Database from "better-sqlite3";
import path from "node:path";
import {
  searchKnowledge,
  searchMemories,
  getRecentMemories,
  indexSingleMemory,
} from "./vector-store.js";

const DB_PATH = process.env.SESSIONS_DB_PATH ?? path.join(process.cwd(), "sessions.db");

// ── MCP Server setup ──

const server = new McpServer({
  name: "knowledge",
  version: "1.0.0",
});

server.tool(
  "search_knowledge",
  "Semantic search across corporate knowledge files (company guidelines, coding standards, repo-specific docs, channel context). Use this when you need institutional knowledge about how the company works, coding conventions, or project-specific context.",
  {
    query: z.string().describe("Search query — describe what you're looking for in natural language"),
    scope: z.enum(["global", "repo", "channel"]).optional().describe("Limit search to a specific scope"),
  },
  async ({ query, scope }) => {
    const results = await searchKnowledge(query, scope);

    if (results.length === 0) {
      return {
        content: [{ type: "text" as const, text: `No knowledge files found matching "${query}".` }],
      };
    }

    const formatted = results.map((r) =>
      `## ${r.file} (${r.scope}) [relevance: ${(r.score * 100).toFixed(0)}%]\n${r.chunk}`
    ).join("\n\n---\n\n");

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  },
);

server.tool(
  "recall_memories",
  "Semantic search across saved team memories — conventions, decisions, corrections, and institutional knowledge accumulated from Slack conversations. Use this when the user asks about past decisions, team conventions, or when you need context about how things are done.",
  {
    query: z.string().optional().describe("Search query — describe what you're looking for. Omit to list recent memories."),
    scope: z.enum(["global", "repo", "channel"]).optional().describe("Limit to a specific scope"),
    scope_key: z.string().optional().describe("Scope key — repo name or channel ID"),
  },
  async ({ query, scope, scope_key }) => {
    if (query) {
      const results = await searchMemories(query, scope, scope_key);

      if (results.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No memories found matching "${query}".` }],
        };
      }

      const formatted = results.map((m) => {
        const scopeLabel = m.scope_key ? `${m.scope}:${m.scope_key}` : m.scope;
        const tags = m.tags ? ` [${m.tags}]` : "";
        const date = new Date(m.created_at * 1000).toLocaleDateString();
        return `- (#${m.id}, ${scopeLabel}${tags}, ${date}, relevance: ${(m.score * 100).toFixed(0)}%) ${m.content}`;
      }).join("\n");

      return {
        content: [{ type: "text" as const, text: formatted }],
      };
    }

    // No query — list recent memories
    const memories = await getRecentMemories(scope, scope_key);

    if (memories.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No memories saved yet." }],
      };
    }

    const formatted = memories.map((m) => {
      const scopeLabel = m.scope_key ? `${m.scope}:${m.scope_key}` : m.scope;
      const tags = m.tags ? ` [${m.tags}]` : "";
      const date = new Date(m.created_at * 1000).toLocaleDateString();
      return `- (#${m.id}, ${scopeLabel}${tags}, ${date}) ${m.content}`;
    }).join("\n");

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  },
);

server.tool(
  "save_memory",
  "Save important information as a team memory — corrections, conventions, decisions, or institutional knowledge worth preserving. Use this proactively when a user corrects you, states a convention, or shares knowledge that future conversations should know about. Do NOT ask for permission first — just save it.",
  {
    content: z.string().describe("The memory to save — a clear, self-contained statement of the convention, decision, or fact"),
    scope: z.enum(["global", "repo", "channel"]).describe("Scope: 'global' for company-wide, 'repo' for repo-specific, 'channel' for channel-specific"),
    scope_key: z.string().optional().describe("Scope key — repo name (for repo scope) or channel ID (for channel scope). Omit for global."),
    tags: z.string().optional().describe("Comma-separated keywords for easier recall later"),
  },
  async ({ content, scope, scope_key, tags }) => {
    let db: Database.Database;
    try {
      db = new Database(DB_PATH);
      db.pragma("journal_mode = WAL");
    } catch {
      return {
        content: [{ type: "text" as const, text: "Failed to save memory: database unavailable." }],
        isError: true,
      };
    }

    try {
      const result = db
        .prepare(
          "INSERT INTO memories (content, scope, scope_key, tags, created_by) VALUES (?, ?, ?, ?, ?)"
        )
        .run(content, scope, scope_key ?? null, tags ?? null, "agent");

      const id = Number(result.lastInsertRowid);

      // Index into vector store for future semantic search
      try {
        await indexSingleMemory(id, content, scope, scope_key ?? null, tags ?? null, "agent");
      } catch (err) {
        // Non-fatal — memory is saved in SQLite, just won't be in vector index until next sync
        console.error("[knowledge-mcp] Failed to index memory in vector store:", err);
      }

      const scopeLabel = scope_key ? `${scope}:${scope_key}` : scope;
      return {
        content: [{ type: "text" as const, text: `Memory #${id} saved (${scopeLabel}): ${content}` }],
      };
    } finally {
      db.close();
    }
  },
);

// ── Start server ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[knowledge-mcp] Fatal error:", err);
  process.exit(1);
});
