import { readFileSync } from "node:fs";
import { getDb, type AuthType } from "./index.js";
import { encrypt, decrypt, type EncryptedValue } from "../crypto.js";

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
  auth_type: AuthType;
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
  authType?: AuthType;
}

export function upsertTool(opts: UpsertToolOpts): void {
  getDb()
    .prepare(`
      INSERT INTO tools (name, description, instruction, mcp_type, mcp_url, mcp_header_auth, mcp_command, mcp_env_passthrough, env_var, auth_type, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(name) DO UPDATE SET
        description = excluded.description,
        instruction = excluded.instruction,
        mcp_type = excluded.mcp_type,
        mcp_url = excluded.mcp_url,
        mcp_header_auth = excluded.mcp_header_auth,
        mcp_command = excluded.mcp_command,
        mcp_env_passthrough = excluded.mcp_env_passthrough,
        env_var = excluded.env_var,
        auth_type = excluded.auth_type,
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
      opts.authType ?? "api_key",
    );
}

export function removeTool(name: string): boolean {
  const database = getDb();
  const txn = database.transaction(() => {
    const result = database.prepare("DELETE FROM tools WHERE name = ?").run(name);
    database.prepare("DELETE FROM oauth_state WHERE tool_name = ?").run(name);
    return result.changes > 0;
  });
  return txn();
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
