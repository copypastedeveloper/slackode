import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { MCPOAuthProvider } from "./oauth-provider.js";
import { getOAuthAccessToken, getOAuthTools } from "../sessions.js";
import { restartServer } from "../opencode-server.js";

/** Minimum remaining lifetime before we proactively refresh (5 minutes). */
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Return a valid access token for the given OAuth tool, refreshing if needed.
 * Returns undefined if the tool has never been authorized.
 */
export async function ensureFreshToken(
  toolName: string,
  serverUrl: string,
): Promise<string | undefined> {
  const stored = getOAuthAccessToken(toolName);
  if (!stored) return undefined;

  // If token is still valid (>5 min remaining), return it
  if (stored.expiryDate === null || stored.expiryDate - Date.now() > REFRESH_THRESHOLD_MS) {
    return stored.accessToken;
  }

  // Token is expired or about to expire — try to refresh
  console.log(`[oauth:${toolName}] Access token expired or expiring soon, attempting refresh...`);

  try {
    const provider = new MCPOAuthProvider(toolName);
    const result = await auth(provider, { serverUrl });

    if (result === "AUTHORIZED") {
      const refreshed = getOAuthAccessToken(toolName);
      if (refreshed) {
        console.log(`[oauth:${toolName}] Token refreshed successfully.`);
        return refreshed.accessToken;
      }
    }

    console.warn(`[oauth:${toolName}] Token refresh returned: ${result}`);
    return stored.accessToken; // Return stale token as fallback
  } catch (err) {
    console.error(`[oauth:${toolName}] Token refresh failed:`, err);
    // Return the existing token even if expired — the MCP server will reject it
    // and the admin can re-auth via `tool auth <name>`
    return stored.accessToken;
  }
}

let refreshInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start a periodic background token refresh for all OAuth tools.
 * Checks every `intervalMs` (default 30 minutes).
 */
export function startPeriodicTokenRefresh(intervalMs = 30 * 60 * 1000): void {
  if (refreshInterval) return;

  refreshInterval = setInterval(async () => {
    const oauthTools = getOAuthTools();
    if (oauthTools.length === 0) return;

    let anyRefreshed = false;
    for (const tool of oauthTools) {
      if (!tool.mcp_url) continue;

      const stored = getOAuthAccessToken(tool.name);
      if (!stored) continue;

      // Only refresh if token is expiring within the threshold
      if (stored.expiryDate !== null && stored.expiryDate - Date.now() < REFRESH_THRESHOLD_MS) {
        const fresh = await ensureFreshToken(tool.name, tool.mcp_url);
        if (fresh && fresh !== stored.accessToken) {
          anyRefreshed = true;
        }
      }
    }

    // If any tokens were refreshed, restart to inject new tokens into config
    if (anyRefreshed) {
      console.log("[oauth] Tokens refreshed — restarting OpenCode server...");
      try {
        await restartServer();
      } catch (err) {
        console.error("[oauth] Restart after periodic refresh failed:", err);
      }
    }
  }, intervalMs);

  console.log(`[oauth] Periodic token refresh started (every ${intervalMs / 60000} min).`);
}

export function stopPeriodicTokenRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
