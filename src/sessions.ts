import Database from "better-sqlite3";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createSession } from "./opencode.js";
import { encrypt, decrypt, type EncryptedValue } from "./crypto.js";

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
    db.exec(`
      CREATE TABLE IF NOT EXISTS tools (
        name TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        instruction TEXT NOT NULL,
        mcp_type TEXT NOT NULL,
        mcp_url TEXT,
        mcp_header_auth TEXT,
        mcp_command TEXT,
        mcp_env_passthrough INTEGER NOT NULL DEFAULT 0,
        env_var TEXT,
        encrypted_key TEXT,
        key_iv TEXT,
        key_tag TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
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

// ── Tool management ──

export interface ToolRow {
  name: string;
  description: string;
  instruction: string;
  mcp_type: string;
  mcp_url: string | null;
  mcp_header_auth: string | null;
  mcp_command: string | null;
  mcp_env_passthrough: number;
  env_var: string | null;
  encrypted_key: string | null;
  key_iv: string | null;
  key_tag: string | null;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export function getToolFromDb(name: string): ToolRow | undefined {
  return getDb()
    .prepare("SELECT * FROM tools WHERE name = ?")
    .get(name) as ToolRow | undefined;
}

export function getAllTools(): ToolRow[] {
  return getDb()
    .prepare("SELECT * FROM tools ORDER BY name")
    .all() as ToolRow[];
}

export function getEnabledTools(): ToolRow[] {
  return getDb()
    .prepare("SELECT * FROM tools WHERE enabled = 1 ORDER BY name")
    .all() as ToolRow[];
}

export interface UpsertToolOpts {
  name: string;
  description: string;
  instruction: string;
  mcpType: string;
  mcpUrl?: string;
  mcpHeaderAuth?: string;
  mcpCommand?: string[];
  mcpEnvPassthrough?: boolean;
  envVar?: string;
}

export function upsertTool(opts: UpsertToolOpts): void {
  getDb()
    .prepare(`
      INSERT INTO tools (name, description, instruction, mcp_type, mcp_url, mcp_header_auth, mcp_command, mcp_env_passthrough, env_var, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        instruction = excluded.instruction,
        mcp_type = excluded.mcp_type,
        mcp_url = excluded.mcp_url,
        mcp_header_auth = excluded.mcp_header_auth,
        mcp_command = excluded.mcp_command,
        mcp_env_passthrough = excluded.mcp_env_passthrough,
        env_var = excluded.env_var,
        updated_at = unixepoch()
    `)
    .run(
      opts.name,
      opts.description,
      opts.instruction,
      opts.mcpType,
      opts.mcpUrl ?? null,
      opts.mcpHeaderAuth ?? null,
      opts.mcpCommand ? JSON.stringify(opts.mcpCommand) : null,
      opts.mcpEnvPassthrough ? 1 : 0,
      opts.envVar ?? null,
    );
}

export function removeTool(name: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM tools WHERE name = ?")
    .run(name);
  return result.changes > 0;
}

export function setToolKey(name: string, plainKey: string): void {
  const enc: EncryptedValue = encrypt(plainKey);
  getDb()
    .prepare(
      "UPDATE tools SET encrypted_key = ?, key_iv = ?, key_tag = ?, updated_at = unixepoch() WHERE name = ?"
    )
    .run(enc.ciphertext, enc.iv, enc.tag, name);
}

export function getToolKey(tool: ToolRow): string | undefined {
  // 1. Encrypted key in DB
  if (tool.encrypted_key) {
    return decrypt(tool.encrypted_key, tool.key_iv ?? "", tool.key_tag ?? "");
  }
  // 2. Fallback to env var
  if (tool.env_var && process.env[tool.env_var]) {
    return process.env[tool.env_var];
  }
  return undefined;
}

export function setToolEnabled(name: string, enabled: boolean): void {
  getDb()
    .prepare("UPDATE tools SET enabled = ?, updated_at = unixepoch() WHERE name = ?")
    .run(enabled ? 1 : 0, name);
}

/**
 * Seed tools from a tools.json file when the tools table is empty (first boot).
 * Does nothing if tools already exist in the DB.
 */
export function seedToolsFromFile(filePath: string): void {
  const existing = getDb()
    .prepare("SELECT COUNT(*) as count FROM tools")
    .get() as { count: number };

  if (existing.count > 0) {
    console.log("[seed] Tools table already has entries, skipping seed.");
    return;
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    console.log(`[seed] No seed file at ${filePath}, skipping.`);
    return;
  }

  const toolDefs: Record<string, {
    description: string;
    instruction: string;
    env: string;
    mcp: {
      type: string;
      url?: string;
      headerAuth?: string;
      command?: string[];
      envPassthrough?: boolean;
      oauth?: boolean;
    };
  }> = JSON.parse(raw);

  const insert = getDb().prepare(`
    INSERT INTO tools (name, description, instruction, mcp_type, mcp_url, mcp_header_auth, mcp_command, mcp_env_passthrough, env_var)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seedMany = getDb().transaction(() => {
    for (const [name, def] of Object.entries(toolDefs)) {
      insert.run(
        name,
        def.description,
        def.instruction,
        def.mcp.type,
        def.mcp.url ?? null,
        def.mcp.headerAuth ?? null,
        def.mcp.command ? JSON.stringify(def.mcp.command) : null,
        def.mcp.envPassthrough ? 1 : 0,
        def.env,
      );
      console.log(`[seed] Tool '${name}' seeded from ${filePath}`);
    }
  });

  seedMany();
}
