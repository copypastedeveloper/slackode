import { getDb } from "./index.js";

// ── Knowledge management ──

export interface KnowledgeRow {
  id: number;
  title: string;
  content: string;
  scope: string;
  scope_key: string | null;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}

export function addKnowledge(
  title: string,
  content: string,
  scope: "global" | "repo" | "channel",
  scopeKey: string | null,
  createdBy: string,
): number {
  const result = getDb()
    .prepare(
      "INSERT INTO knowledge (title, content, scope, scope_key, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(title, content, scope, scopeKey, createdBy, createdBy);
  return Number(result.lastInsertRowid);
}

export function getKnowledgeById(id: number): KnowledgeRow | undefined {
  return getDb()
    .prepare("SELECT * FROM knowledge WHERE id = ?")
    .get(id) as KnowledgeRow | undefined;
}

export function getKnowledgeByTitle(
  title: string,
  scope?: string,
  scopeKey?: string,
): KnowledgeRow | undefined {
  if (scope && scopeKey !== undefined) {
    return getDb()
      .prepare("SELECT * FROM knowledge WHERE title = ? AND scope = ? AND scope_key IS ?")
      .get(title, scope, scopeKey ?? null) as KnowledgeRow | undefined;
  }
  // Search across all scopes, return first match
  return getDb()
    .prepare("SELECT * FROM knowledge WHERE title = ? ORDER BY updated_at DESC LIMIT 1")
    .get(title) as KnowledgeRow | undefined;
}

export function updateKnowledge(id: number, content: string, updatedBy: string): boolean {
  const result = getDb()
    .prepare("UPDATE knowledge SET content = ?, updated_by = ?, updated_at = unixepoch() WHERE id = ?")
    .run(content, updatedBy, id);
  return result.changes > 0;
}

export function removeKnowledge(id: number): boolean {
  const result = getDb()
    .prepare("DELETE FROM knowledge WHERE id = ?")
    .run(id);
  return result.changes > 0;
}

export function listKnowledge(
  scope?: string,
  scopeKey?: string,
): KnowledgeRow[] {
  if (scope && scopeKey !== undefined) {
    return getDb()
      .prepare("SELECT * FROM knowledge WHERE scope = ? AND scope_key IS ? ORDER BY title")
      .all(scope, scopeKey ?? null) as KnowledgeRow[];
  }
  if (scope) {
    return getDb()
      .prepare("SELECT * FROM knowledge WHERE scope = ? ORDER BY title")
      .all(scope) as KnowledgeRow[];
  }
  return getDb()
    .prepare("SELECT * FROM knowledge ORDER BY scope, title")
    .all() as KnowledgeRow[];
}

// ── Google Docs sync sources ──

export interface KnowledgeSourceRow {
  google_file_id: string;
  knowledge_id: number;
  file_name: string;
  modified_time: string;
  last_synced_at: number;
}

export function upsertKnowledgeSource(
  googleFileId: string,
  knowledgeId: number,
  fileName: string,
  modifiedTime: string,
): void {
  getDb()
    .prepare(`
      INSERT INTO knowledge_sources (google_file_id, knowledge_id, file_name, modified_time, last_synced_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(google_file_id) DO UPDATE SET
        knowledge_id = excluded.knowledge_id,
        file_name = excluded.file_name,
        modified_time = excluded.modified_time,
        last_synced_at = unixepoch()
    `)
    .run(googleFileId, knowledgeId, fileName, modifiedTime);
}

export function getKnowledgeSource(googleFileId: string): KnowledgeSourceRow | undefined {
  return getDb()
    .prepare("SELECT * FROM knowledge_sources WHERE google_file_id = ?")
    .get(googleFileId) as KnowledgeSourceRow | undefined;
}

export function getAllKnowledgeSources(): KnowledgeSourceRow[] {
  return getDb()
    .prepare("SELECT * FROM knowledge_sources ORDER BY file_name")
    .all() as KnowledgeSourceRow[];
}

export function removeKnowledgeSource(googleFileId: string): boolean {
  const database = getDb();
  const txn = database.transaction(() => {
    const source = database
      .prepare("SELECT knowledge_id FROM knowledge_sources WHERE google_file_id = ?")
      .get(googleFileId) as { knowledge_id: number } | undefined;
    const result = database
      .prepare("DELETE FROM knowledge_sources WHERE google_file_id = ?")
      .run(googleFileId);
    if (source) {
      database.prepare("DELETE FROM knowledge WHERE id = ?").run(source.knowledge_id);
    }
    return result.changes > 0;
  });
  return txn();
}

export function getKnowledgeContent(
  scope: string,
  scopeKey?: string,
  maxChars?: number,
): string {
  const rows = scopeKey !== undefined
    ? getDb()
        .prepare("SELECT title, content FROM knowledge WHERE scope = ? AND scope_key IS ? ORDER BY title")
        .all(scope, scopeKey ?? null) as Array<{ title: string; content: string }>
    : getDb()
        .prepare("SELECT title, content FROM knowledge WHERE scope = ? ORDER BY title")
        .all(scope) as Array<{ title: string; content: string }>;

  const parts: string[] = [];
  let totalLen = 0;

  for (const row of rows) {
    const text = row.content.trim();
    if (!text) continue;

    if (maxChars && totalLen + text.length > maxChars) {
      const remaining = maxChars - totalLen;
      if (remaining > 100) {
        parts.push(text.slice(0, remaining) + "\n[...truncated]");
      }
      break;
    }

    parts.push(text);
    totalLen += text.length;
  }

  return parts.join("\n\n");
}
