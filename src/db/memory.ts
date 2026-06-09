import { getDb } from "./index.js";

export interface MemoryRow {
  id: number;
  content: string;
  scope: string;
  scope_key: string | null;
  tags: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export function addMemory(
  content: string,
  scope: "global" | "repo" | "channel",
  scopeKey: string | null,
  tags: string | null,
  createdBy: string,
): number {
  const result = getDb()
    .prepare(
      "INSERT INTO memories (content, scope, scope_key, tags, created_by) VALUES (?, ?, ?, ?, ?)"
    )
    .run(content, scope, scopeKey, tags, createdBy);
  return Number(result.lastInsertRowid);
}

/**
 * Get memories relevant to a given context (repo + channel).
 * Returns global + matching repo + matching channel memories, ordered by recency.
 */
export function getMemoriesForContext(
  repoName?: string,
  channelId?: string,
  limit = 20,
): MemoryRow[] {
  const conditions: string[] = ["scope = 'global'"];
  const params: unknown[] = [];

  if (repoName) {
    conditions.push("(scope = 'repo' AND scope_key = ?)");
    params.push(repoName);
  }
  if (channelId) {
    conditions.push("(scope = 'channel' AND scope_key = ?)");
    params.push(channelId);
  }

  const where = conditions.join(" OR ");
  return getDb()
    .prepare(`SELECT * FROM memories WHERE ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params, limit) as MemoryRow[];
}

export function deleteMemory(id: number, userId: string): boolean {
  // Allow deletion if the user created it OR if it was created by 'agent'
  const result = getDb()
    .prepare("DELETE FROM memories WHERE id = ? AND (created_by = ? OR created_by = 'agent')")
    .run(id, userId);
  return result.changes > 0;
}
