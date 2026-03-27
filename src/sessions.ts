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
        channel_id TEXT,
        compacted INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    // Migrations for existing databases.
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN compacted INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists — ignore.
    }
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN channel_id TEXT`);
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS repos (
        name TEXT PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        dir TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_repos (
        channel_id TEXT PRIMARY KEY,
        channel_name TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS coding_sessions (
        thread_key TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        repo_name TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        port INTEGER NOT NULL,
        agent TEXT NOT NULL DEFAULT 'code',
        opencode_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'starting',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_activity_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS permissions (
        user_id TEXT PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('admin', 'developer')),
        granted_by TEXT NOT NULL,
        granted_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_github_tokens (
        user_id TEXT PRIMARY KEY,
        encrypted_token TEXT NOT NULL,
        token_iv TEXT NOT NULL,
        token_tag TEXT NOT NULL,
        github_username TEXT NOT NULL,
        github_name TEXT NOT NULL,
        github_email TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'repo',
        scope_key TEXT,
        tags TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_key)
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

export function saveSession(threadKey: string, sessionId: string, channelId?: string): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO sessions (thread_key, session_id, channel_id) VALUES (?, ?, ?)"
    )
    .run(threadKey, sessionId, channelId ?? null);
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
  threadKey: string,
  channelId?: string,
): Promise<{ sessionId: string; isNew: boolean }> {
  const existing = getSessionId(threadKey);
  if (existing) {
    return { sessionId: existing, isNew: false };
  }

  const sessionId = await createSession(`Slack thread: ${threadKey}`);
  saveSession(threadKey, sessionId, channelId);

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

// ── Repo management ──

export interface RepoRow {
  name: string;
  url: string;
  dir: string;
  is_default: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export function getRepo(name: string): RepoRow | undefined {
  return getDb()
    .prepare("SELECT * FROM repos WHERE name = ?")
    .get(name) as RepoRow | undefined;
}

export function getAllRepos(): RepoRow[] {
  return getDb()
    .prepare("SELECT * FROM repos ORDER BY name")
    .all() as RepoRow[];
}

export function getEnabledRepos(): RepoRow[] {
  return getDb()
    .prepare("SELECT * FROM repos WHERE enabled = 1 ORDER BY name")
    .all() as RepoRow[];
}

export function getDefaultRepo(): RepoRow | undefined {
  return getDb()
    .prepare("SELECT * FROM repos WHERE is_default = 1 LIMIT 1")
    .get() as RepoRow | undefined;
}

export function upsertRepo(name: string, url: string, dir: string, isDefault: boolean): void {
  getDb()
    .prepare(`
      INSERT INTO repos (name, url, dir, is_default, updated_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(name) DO UPDATE SET
        url = excluded.url,
        dir = excluded.dir,
        is_default = excluded.is_default,
        updated_at = unixepoch()
    `)
    .run(name, url, dir, isDefault ? 1 : 0);
}

export function removeRepo(name: string): boolean {
  const database = getDb();
  const txn = database.transaction(() => {
    const result = database
      .prepare("DELETE FROM repos WHERE name = ?")
      .run(name);
    // Also remove any channel mappings pointing to this repo
    database
      .prepare("DELETE FROM channel_repos WHERE repo_name = ?")
      .run(name);
    return result.changes > 0;
  });
  return txn();
}

export function setDefaultRepo(name: string): void {
  const database = getDb();
  const txn = database.transaction(() => {
    database.prepare("UPDATE repos SET is_default = 0 WHERE is_default = 1").run();
    database.prepare("UPDATE repos SET is_default = 1, updated_at = unixepoch() WHERE name = ?").run(name);
  });
  txn();
}

export function setRepoEnabled(name: string, enabled: boolean): void {
  getDb()
    .prepare("UPDATE repos SET enabled = ?, updated_at = unixepoch() WHERE name = ?")
    .run(enabled ? 1 : 0, name);
}

// ── Channel-to-repo mapping ──

export function getChannelRepo(channelId: string): string | undefined {
  const row = getDb()
    .prepare("SELECT repo_name FROM channel_repos WHERE channel_id = ?")
    .get(channelId) as { repo_name: string } | undefined;
  return row?.repo_name;
}

export function setChannelRepo(channelId: string, channelName: string, repoName: string): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO channel_repos (channel_id, channel_name, repo_name, updated_at) VALUES (?, ?, ?, unixepoch())"
    )
    .run(channelId, channelName, repoName);
}

export function clearChannelRepo(channelId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM channel_repos WHERE channel_id = ?")
    .run(channelId);
  return result.changes > 0;
}

export interface ChannelRepoRow {
  channel_id: string;
  channel_name: string;
  repo_name: string;
}

export function listChannelRepos(): ChannelRepoRow[] {
  return getDb()
    .prepare("SELECT channel_id, channel_name, repo_name FROM channel_repos ORDER BY channel_name")
    .all() as ChannelRepoRow[];
}

// ── Coding session statuses ──

export const SessionStatus = {
  STARTING: "starting",
  PLANNING: "planning",
  AWAITING_APPROVAL: "awaiting_approval",
  ACTIVE: "active",
} as const;

export type SessionStatusType = (typeof SessionStatus)[keyof typeof SessionStatus];

/** All statuses that represent a "live" session (not destroyed). */
export const LIVE_STATUSES = [
  SessionStatus.STARTING,
  SessionStatus.PLANNING,
  SessionStatus.AWAITING_APPROVAL,
  SessionStatus.ACTIVE,
] as const;

/** Statuses that should be reaped after idle timeout. */
export const REAPABLE_STATUSES = [
  SessionStatus.ACTIVE,
  SessionStatus.PLANNING,
  SessionStatus.AWAITING_APPROVAL,
] as const;

// ── Coding sessions ──

export interface CodingSessionRow {
  thread_key: string;
  user_id: string;
  channel_id: string;
  repo_name: string;
  branch: string;
  worktree_path: string;
  port: number;
  agent: string;
  opencode_session_id: string | null;
  status: string;
  created_at: number;
  last_activity_at: number;
}

export function getCodingSession(threadKey: string): CodingSessionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM coding_sessions WHERE thread_key = ?")
    .get(threadKey) as CodingSessionRow | undefined;
}

export function getAllCodingSessions(): CodingSessionRow[] {
  return getDb()
    .prepare("SELECT * FROM coding_sessions ORDER BY created_at DESC")
    .all() as CodingSessionRow[];
}

export function getActiveCodingSessions(): CodingSessionRow[] {
  return getDb()
    .prepare(`SELECT * FROM coding_sessions WHERE status IN (${LIVE_STATUSES.map((s) => `'${s}'`).join(",")}) ORDER BY created_at DESC`)
    .all() as CodingSessionRow[];
}

export function saveCodingSession(opts: {
  threadKey: string;
  userId: string;
  channelId: string;
  repoName: string;
  branch: string;
  worktreePath: string;
  port: number;
  agent?: string;
}): void {
  getDb()
    .prepare(`
      INSERT INTO coding_sessions (thread_key, user_id, channel_id, repo_name, branch, worktree_path, port, agent, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting')
    `)
    .run(opts.threadKey, opts.userId, opts.channelId, opts.repoName, opts.branch, opts.worktreePath, opts.port, opts.agent ?? "code");
}

export function updateCodingSessionAgent(threadKey: string, agent: string): void {
  getDb()
    .prepare("UPDATE coding_sessions SET agent = ?, last_activity_at = unixepoch() WHERE thread_key = ?")
    .run(agent, threadKey);
}

export function updateCodingSessionStatus(threadKey: string, status: string): void {
  getDb()
    .prepare("UPDATE coding_sessions SET status = ?, last_activity_at = unixepoch() WHERE thread_key = ?")
    .run(status, threadKey);
}

export function updateCodingSessionOpencode(threadKey: string, sessionId: string): void {
  getDb()
    .prepare("UPDATE coding_sessions SET opencode_session_id = ?, last_activity_at = unixepoch() WHERE thread_key = ?")
    .run(sessionId, threadKey);
}

export function touchCodingSession(threadKey: string): void {
  getDb()
    .prepare("UPDATE coding_sessions SET last_activity_at = unixepoch() WHERE thread_key = ?")
    .run(threadKey);
}

export function deleteCodingSession(threadKey: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM coding_sessions WHERE thread_key = ?")
    .run(threadKey);
  return result.changes > 0;
}

export function getIdleCodingSessions(maxIdleSeconds: number): CodingSessionRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM coding_sessions WHERE status IN (${REAPABLE_STATUSES.map((s) => `'${s}'`).join(",")}) AND (unixepoch() - last_activity_at) > ?`
    )
    .all(maxIdleSeconds) as CodingSessionRow[];
}

// ── Permissions ──

const ROLE_RANK: Record<string, number> = { admin: 2, developer: 1, user: 0 };

export type Role = "admin" | "developer" | "user";

export function getUserRole(userId: string): Role {
  const row = getDb()
    .prepare("SELECT role FROM permissions WHERE user_id = ?")
    .get(userId) as { role: string } | undefined;
  return (row?.role as Role) ?? "user";
}

export function hasRole(userId: string, minRole: "admin" | "developer"): boolean {
  const actual = getUserRole(userId);
  return (ROLE_RANK[actual] ?? 0) >= (ROLE_RANK[minRole] ?? 0);
}

export function setRole(userId: string, role: "admin" | "developer", grantedBy: string): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO permissions (user_id, role, granted_by, granted_at) VALUES (?, ?, ?, unixepoch())"
    )
    .run(userId, role, grantedBy);
}

export function removeRole(userId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM permissions WHERE user_id = ?")
    .run(userId);
  return result.changes > 0;
}

export interface PermissionRow {
  user_id: string;
  role: string;
  granted_by: string;
  granted_at: number;
}

export function listPermissions(): PermissionRow[] {
  return getDb()
    .prepare("SELECT user_id, role, granted_by, granted_at FROM permissions ORDER BY granted_at")
    .all() as PermissionRow[];
}

export function bootstrapAdmins(userIds: string[]): void {
  const database = getDb();
  const insert = database.prepare(
    "INSERT OR IGNORE INTO permissions (user_id, role, granted_by) VALUES (?, 'admin', 'ENV')"
  );
  const txn = database.transaction(() => {
    for (const id of userIds) {
      insert.run(id);
    }
  });
  txn();
}

// ── Memory management ──

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

// ── User GitHub tokens ──

export interface UserGithubTokenRow {
  user_id: string;
  encrypted_token: string;
  token_iv: string;
  token_tag: string;
  github_username: string;
  github_name: string;
  github_email: string;
  created_at: number;
  updated_at: number;
}

export function saveUserGithubToken(
  userId: string,
  encToken: string,
  iv: string,
  tag: string,
  username: string,
  name: string,
  email: string,
): void {
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO user_github_tokens
        (user_id, encrypted_token, token_iv, token_tag, github_username, github_name, github_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    `)
    .run(userId, encToken, iv, tag, username, name, email);
}

export function getUserGithubToken(userId: string): UserGithubTokenRow | undefined {
  return getDb()
    .prepare("SELECT * FROM user_github_tokens WHERE user_id = ?")
    .get(userId) as UserGithubTokenRow | undefined;
}

export function getUserGithubPAT(userId: string): {
  token: string;
  username: string;
  name: string;
  email: string;
} | undefined {
  const row = getUserGithubToken(userId);
  if (!row) return undefined;
  const token = decrypt(row.encrypted_token, row.token_iv, row.token_tag);
  return {
    token,
    username: row.github_username,
    name: row.github_name,
    email: row.github_email,
  };
}

export function deleteUserGithubToken(userId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM user_github_tokens WHERE user_id = ?")
    .run(userId);
  return result.changes > 0;
}
