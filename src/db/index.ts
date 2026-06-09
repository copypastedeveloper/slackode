import Database from "better-sqlite3";
import path from "node:path";

export type AuthType = "api_key" | "oauth";

const DB_PATH = process.env.SESSIONS_DB_PATH || path.join(process.cwd(), "sessions.db");

let db: Database.Database;

export function getDb(): Database.Database {
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
    try {
      db.exec(`ALTER TABLE tools ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'api_key'`);
    } catch {
      // Column already exists — ignore.
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_state (
        tool_name TEXT PRIMARY KEY,
        client_id TEXT,
        client_secret TEXT,
        client_id_issued_at INTEGER,
        client_secret_expires_at INTEGER,
        access_token TEXT,
        access_token_iv TEXT,
        access_token_tag TEXT,
        refresh_token TEXT,
        refresh_token_iv TEXT,
        refresh_token_tag TEXT,
        expiry_date INTEGER,
        code_verifier TEXT,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_pending_states (
        state TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        code_verifier TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
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
        allow_skills INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    try {
      db.exec(`ALTER TABLE repos ADD COLUMN allow_skills INTEGER NOT NULL DEFAULT 1`);
    } catch {
      // Column already exists — ignore.
    }
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
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        scope_key TEXT,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_scope_title ON knowledge(scope, scope_key, title)
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        google_file_id TEXT PRIMARY KEY,
        knowledge_id INTEGER NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        modified_time TEXT NOT NULL,
        last_synced_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL DEFAULT (unixepoch()),
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_name TEXT,
        thread_key TEXT,
        session_id TEXT,
        agent TEXT,
        repo_name TEXT,
        tools_enabled TEXT,
        tools_used TEXT,
        skills_used TEXT,
        question_chars INTEGER,
        response_chars INTEGER,
        duration_ms INTEGER,
        step_count INTEGER,
        outcome TEXT NOT NULL,
        outcome_detail TEXT,
        compacted INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_turns_user_ts ON turns(user_id, ts)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_turns_channel_ts ON turns(channel_id, ts)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_turns_outcome_ts ON turns(outcome, ts)`);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
  }
}
