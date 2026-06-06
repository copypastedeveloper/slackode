import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "../crypto.js";
import {
  getOAuthState,
  upsertOAuthTokens,
  upsertOAuthClientInfo,
  upsertOAuthCodeVerifier,
  savePendingOAuthState,
  findAndDeletePendingOAuthState,
  clearOAuthState,
} from "../sessions.js";

/**
 * Static landing page served as a data URI.
 * The OAuth provider redirects here with ?code=...&state=...
 * The page extracts the code and tells the admin to paste it in Slack.
 *
 * We use `urn:ietf:wg:oauth:2.0:oob` as the redirect — some providers
 * support it natively. For providers that require a real URL, set
 * OAUTH_REDIRECT_URI to a hosted static page that does the same thing.
 */
const DEFAULT_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI ?? "http://localhost:3456/oauth/callback";

/**
 * SQLite-backed OAuthClientProvider for MCP servers.
 * Single account per tool (no userId dimension).
 * Encrypts access/refresh tokens via crypto.ts.
 *
 * Instead of running a callback server, the redirect URI points to a
 * static page that displays the authorization code. The admin pastes
 * the code back into Slack via `tool auth-code <name> <code>`.
 */
export class MCPOAuthProvider implements OAuthClientProvider {
  readonly toolName: string;
  private redirectUri: string;
  private lastGeneratedState: string | null = null;

  /** Set externally to surface auth URLs to the caller (e.g. Slack) */
  onAuthRedirect?: (toolName: string, authUrl: URL) => void;

  constructor(toolName: string, redirectUri?: string) {
    this.toolName = toolName;
    this.redirectUri = redirectUri ?? DEFAULT_REDIRECT_URI;
  }

  get redirectUrl(): string {
    return this.redirectUri;
  }

  state(): string {
    this.lastGeneratedState = randomBytes(16).toString("hex");
    return this.lastGeneratedState;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUri],
      client_name: `Slackode (${this.toolName})`,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const row = getOAuthState(this.toolName);
    if (!row?.client_id) return undefined;

    return {
      client_id: row.client_id,
      client_secret: row.client_secret ?? undefined,
      client_id_issued_at: row.client_id_issued_at ?? undefined,
      client_secret_expires_at: row.client_secret_expires_at ?? undefined,
    };
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    upsertOAuthClientInfo(this.toolName, {
      clientId: info.client_id,
      clientSecret: "client_secret" in info ? (info.client_secret as string) : null,
      clientIdIssuedAt: "client_id_issued_at" in info ? (info.client_id_issued_at as number) : null,
      clientSecretExpiresAt:
        "client_secret_expires_at" in info ? (info.client_secret_expires_at as number) : null,
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const row = getOAuthState(this.toolName);
    if (!row?.access_token) return undefined;

    const accessToken = decrypt(row.access_token, row.access_token_iv ?? "", row.access_token_tag ?? "");
    const refreshToken = row.refresh_token
      ? decrypt(row.refresh_token, row.refresh_token_iv ?? "", row.refresh_token_tag ?? "")
      : undefined;

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "bearer",
      expires_in: row.expiry_date
        ? Math.max(0, Math.floor((row.expiry_date - Date.now()) / 1000))
        : undefined,
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const expiryDate = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null;

    const encAccess = encrypt(tokens.access_token);
    const encRefresh = tokens.refresh_token ? encrypt(tokens.refresh_token) : null;

    upsertOAuthTokens(this.toolName, {
      accessToken: encAccess.ciphertext,
      accessTokenIv: encAccess.iv,
      accessTokenTag: encAccess.tag,
      refreshToken: encRefresh?.ciphertext,
      refreshTokenIv: encRefresh?.iv,
      refreshTokenTag: encRefresh?.tag,
      expiryDate,
    });

    console.log(`[mcp:${this.toolName}] OAuth tokens saved (encrypted).`);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    console.log(`[mcp-oauth:${this.toolName}] redirectToAuthorization: ${authorizationUrl}`);
    if (this.onAuthRedirect) {
      this.onAuthRedirect(this.toolName, authorizationUrl);
    } else {
      console.warn(`[mcp-oauth:${this.toolName}] No onAuthRedirect handler set!`);
    }
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    // Save to main table as fallback
    upsertOAuthCodeVerifier(this.toolName, codeVerifier);

    // Save verifier alongside its state in the pending table
    if (this.lastGeneratedState) {
      savePendingOAuthState(this.lastGeneratedState, this.toolName, codeVerifier);
    }
  }

  async saveOAuthState(state: string): Promise<void> {
    savePendingOAuthState(state, this.toolName);
  }

  /** Override the verifier returned by codeVerifier() for a specific callback flow */
  private overrideCodeVerifier: string | null = null;

  setCodeVerifierOverride(verifier: string): void {
    this.overrideCodeVerifier = verifier;
  }

  async codeVerifier(): Promise<string> {
    if (this.overrideCodeVerifier) {
      const v = this.overrideCodeVerifier;
      this.overrideCodeVerifier = null;
      return v;
    }
    const row = getOAuthState(this.toolName);
    return row?.code_verifier ?? "";
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all") {
      clearOAuthState(this.toolName);
    }
  }

  /**
   * Look up a pending OAuth state and delete it (consume once).
   */
  static findByOAuthState(
    state: string,
  ): { toolName: string; codeVerifier: string | null } | null {
    return findAndDeletePendingOAuthState(state);
  }
}
