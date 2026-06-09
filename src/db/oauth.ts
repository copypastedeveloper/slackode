import { getDb } from "./index.js";
import { decrypt } from "../crypto.js";
import { type ToolRow } from "./tools.js";

export interface OAuthStateRow {
  tool_name: string;
  client_id: string | null;
  client_secret: string | null;
  client_id_issued_at: number | null;
  client_secret_expires_at: number | null;
  access_token: string | null;
  access_token_iv: string | null;
  access_token_tag: string | null;
  refresh_token: string | null;
  refresh_token_iv: string | null;
  refresh_token_tag: string | null;
  expiry_date: number | null;
  code_verifier: string | null;
  updated_at: number;
}

export function getOAuthState(toolName: string): OAuthStateRow | undefined {
  return getDb()
    .prepare("SELECT * FROM oauth_state WHERE tool_name = ?")
    .get(toolName) as OAuthStateRow | undefined;
}

export function upsertOAuthTokens(
  toolName: string,
  tokens: {
    accessToken: string;
    accessTokenIv: string;
    accessTokenTag: string;
    refreshToken?: string;
    refreshTokenIv?: string;
    refreshTokenTag?: string;
    expiryDate?: number | null;
  },
): void {
  getDb()
    .prepare(`
      INSERT INTO oauth_state (tool_name, access_token, access_token_iv, access_token_tag, refresh_token, refresh_token_iv, refresh_token_tag, expiry_date, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(tool_name) DO UPDATE SET
        access_token = excluded.access_token,
        access_token_iv = excluded.access_token_iv,
        access_token_tag = excluded.access_token_tag,
        refresh_token = excluded.refresh_token,
        refresh_token_iv = excluded.refresh_token_iv,
        refresh_token_tag = excluded.refresh_token_tag,
        expiry_date = excluded.expiry_date,
        updated_at = unixepoch()
    `)
    .run(
      toolName,
      tokens.accessToken,
      tokens.accessTokenIv,
      tokens.accessTokenTag,
      tokens.refreshToken ?? null,
      tokens.refreshTokenIv ?? null,
      tokens.refreshTokenTag ?? null,
      tokens.expiryDate ?? null,
    );
}

export function upsertOAuthClientInfo(
  toolName: string,
  info: {
    clientId: string;
    clientSecret?: string | null;
    clientIdIssuedAt?: number | null;
    clientSecretExpiresAt?: number | null;
  },
): void {
  getDb()
    .prepare(`
      INSERT INTO oauth_state (tool_name, client_id, client_secret, client_id_issued_at, client_secret_expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(tool_name) DO UPDATE SET
        client_id = excluded.client_id,
        client_secret = excluded.client_secret,
        client_id_issued_at = excluded.client_id_issued_at,
        client_secret_expires_at = excluded.client_secret_expires_at,
        updated_at = unixepoch()
    `)
    .run(
      toolName,
      info.clientId,
      info.clientSecret ?? null,
      info.clientIdIssuedAt ?? null,
      info.clientSecretExpiresAt ?? null,
    );
}

export function upsertOAuthCodeVerifier(toolName: string, codeVerifier: string): void {
  getDb()
    .prepare(`
      INSERT INTO oauth_state (tool_name, code_verifier, updated_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(tool_name) DO UPDATE SET
        code_verifier = excluded.code_verifier,
        updated_at = unixepoch()
    `)
    .run(toolName, codeVerifier);
}

export function savePendingOAuthState(state: string, toolName: string, codeVerifier?: string): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO oauth_pending_states (state, tool_name, code_verifier, created_at) VALUES (?, ?, ?, unixepoch())"
    )
    .run(state, toolName, codeVerifier ?? null);
}

export function findAndDeletePendingOAuthState(
  state: string,
): { toolName: string; codeVerifier: string | null } | null {
  const database = getDb();
  const row = database
    .prepare("SELECT tool_name, code_verifier FROM oauth_pending_states WHERE state = ?")
    .get(state) as { tool_name: string; code_verifier: string | null } | undefined;

  if (!row) return null;

  database.prepare("DELETE FROM oauth_pending_states WHERE state = ?").run(state);
  return { toolName: row.tool_name, codeVerifier: row.code_verifier };
}

export function clearOAuthState(toolName: string): void {
  getDb().prepare("DELETE FROM oauth_state WHERE tool_name = ?").run(toolName);
}

/**
 * Decrypt and return the access token + expiry for an OAuth tool.
 */
export function getOAuthAccessToken(toolName: string): { accessToken: string; expiryDate: number | null } | undefined {
  const row = getOAuthState(toolName);
  if (!row?.access_token) return undefined;

  const accessToken = decrypt(row.access_token, row.access_token_iv ?? "", row.access_token_tag ?? "");
  return { accessToken, expiryDate: row.expiry_date };
}

/**
 * Get all OAuth-enabled tools.
 */
export function getOAuthTools(): ToolRow[] {
  return getDb()
    .prepare("SELECT * FROM tools WHERE auth_type = 'oauth' AND enabled = 1 ORDER BY name")
    .all() as ToolRow[];
}
