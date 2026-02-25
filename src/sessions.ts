import Database from "better-sqlite3";
import path from "node:path";
import { createSession } from "./opencode.js";

const DB_PATH = process.env.SESSIONS_DB_PATH || path.join(process.cwd(), "sessions.db");

let db: Database.Database;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        thread_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        compacted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    // Migration for existing databases that lack the compacted column.
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists — ignore.
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_agents (
        channel_id TEXT PRIMARY KEY,
        channel_name TEXT NOT NULL,
        agent TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_tools (
        channel_id TEXT PRIMARY KEY,
        channel_name TEXT NOT NULL,
        tools TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_config (
        channel_id TEXT PRIMARY KEY,
        custom_prompt TEXT NOT NULL,
        configured_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
  }
  return db;
}

export function getSessionId(threadKey: string): string | undefined {
  const row = getDb()
    .prepare("SELECT session_id FROM sessions WHERE thread_key = ?")
    .get(threadKey) as { session_id: string } | undefined;
  return row?.session_id;
}

export function saveSession(threadKey: string, sessionId: string): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO sessions (thread_key, session_id) VALUES (?, ?)"
    )
    .run(threadKey, sessionId);
}

export function isSessionCompacted(threadKey: string): boolean {
  const row = getDb()
    .prepare("SELECT compacted FROM sessions WHERE thread_key = ?")
    .get(threadKey) as { compacted: number } | undefined;
  return row?.compacted === 1;
}

export function setSessionCompacted(threadKey: string, compacted: boolean): void {
  getDb()
    .prepare("UPDATE sessions SET compacted = ? WHERE thread_key = ?")
    .run(compacted ? 1 : 0, threadKey);
}

/**
 * Get an existing session or create a new one.
 * Returns isNew so the caller can include full context in the first message.
 */
export async function getOrCreateSession(
  threadKey: string
): Promise<{ sessionId: string; isNew: boolean }> {
  const existing = getSessionId(threadKey);
  if (existing) {
    return { sessionId: existing, isNew: false };
  }

  const sessionId = await createSession(`Slack thread: ${threadKey}`);
  saveSession(threadKey, sessionId);

  return { sessionId, isNew: true };
}

// --- Channel-to-agent mapping ---

export function getChannelAgent(channelId: string): string | undefined {
  const row = getDb()
    .prepare("SELECT agent FROM channel_agents WHERE channel_id = ?")
    .get(channelId) as { agent: string } | undefined;
  return row?.agent;
}

export function setChannelAgent(channelId: string, channelName: string, agent: string): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO channel_agents (channel_id, channel_name, agent, updated_at) VALUES (?, ?, ?, unixepoch())"
    )
    .run(channelId, channelName, agent);
}

export function clearChannelAgent(channelId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM channel_agents WHERE channel_id = ?")
    .run(channelId);
  return result.changes > 0;
}

export interface ChannelAgentRow {
  channel_id: string;
  channel_name: string;
  agent: string;
}

export function listChannelAgents(): ChannelAgentRow[] {
  return getDb()
    .prepare("SELECT channel_id, channel_name, agent FROM channel_agents ORDER BY channel_name")
    .all() as ChannelAgentRow[];
}

// --- Channel-to-tools mapping ---

export function getChannelTools(channelId: string): string[] | undefined {
  const row = getDb()
    .prepare("SELECT tools FROM channel_tools WHERE channel_id = ?")
    .get(channelId) as { tools: string } | undefined;
  if (!row) return undefined;
  return row.tools.split(",").filter(Boolean);
}

export function setChannelTools(channelId: string, channelName: string, tools: string[]): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO channel_tools (channel_id, channel_name, tools, updated_at) VALUES (?, ?, ?, unixepoch())"
    )
    .run(channelId, channelName, tools.join(","));
}

export function clearChannelTools(channelId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM channel_tools WHERE channel_id = ?")
    .run(channelId);
  return result.changes > 0;
}

export interface ChannelToolsRow {
  channel_id: string;
  channel_name: string;
  tools: string;
}

export function listChannelTools(): ChannelToolsRow[] {
  return getDb()
    .prepare("SELECT channel_id, channel_name, tools FROM channel_tools ORDER BY channel_name")
    .all() as ChannelToolsRow[];
}

/**
 * Resolve the OpenCode agent name based on channel agent and tools.
 * If a custom agent is set, it takes priority (tools are ignored).
 * Otherwise, tools map to predefined agent variants (e.g. build-linear, build-sentry).
 */
export function resolveAgent(channelAgent?: string, channelTools?: string[]): string | undefined {
  if (channelAgent) return channelAgent;
  if (!channelTools || channelTools.length === 0) return undefined;
  const sorted = [...channelTools].sort();
  return `build-${sorted.join("-")}`;
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}

// ── Channel config ──

export function getChannelConfig(
  channelId: string
): { customPrompt: string; configuredBy: string } | null {
  const row = getDb()
    .prepare("SELECT custom_prompt, configured_by FROM channel_config WHERE channel_id = ?")
    .get(channelId) as { custom_prompt: string; configured_by: string } | undefined;
  if (!row) return null;
  return { customPrompt: row.custom_prompt, configuredBy: row.configured_by };
}

export function setChannelConfig(
  channelId: string,
  customPrompt: string,
  configuredBy: string
): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO channel_config (channel_id, custom_prompt, configured_by, updated_at) VALUES (?, ?, ?, unixepoch())"
    )
    .run(channelId, customPrompt, configuredBy);
}

export function clearChannelConfig(channelId: string): void {
  getDb()
    .prepare("DELETE FROM channel_config WHERE channel_id = ?")
    .run(channelId);
}
