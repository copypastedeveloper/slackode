/**
 * Linear agent configuration, read from the environment.
 *
 * The Linear surface is off unless all three credentials are set, so existing
 * Slack-only deployments see no change (no listener, no extra agent).
 */

export interface LinearConfig {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  /** Port for the webhook listener (also serves GET /health). */
  port: number;
  /** MCP tool names the Linear agent may use, e.g. ["linear", "sentry"]. */
  tools: string[];
}

export const DEFAULT_LINEAR_PORT = 8080;

/** The pseudo channel ID Linear conversations are recorded under (sessions, turns, repo routing). */
export const LINEAR_CHANNEL_ID = "linear";

/** OpenCode agent the Linear surface runs as (generated in opencode-config.ts). */
export const LINEAR_AGENT_NAME = "linear";

/**
 * Returns the Linear config, or null when the surface is disabled.
 * A partial config (some credentials set, others missing) is logged and
 * treated as disabled rather than crashing the Slack bot.
 */
export function readLinearConfig(env: NodeJS.ProcessEnv = process.env): LinearConfig | null {
  const clientId = env.LINEAR_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.LINEAR_CLIENT_SECRET?.trim() ?? "";
  const webhookSecret = env.LINEAR_WEBHOOK_SECRET?.trim() ?? "";

  const present = [clientId, clientSecret, webhookSecret].filter(Boolean).length;
  if (present === 0) return null;
  if (present < 3) {
    console.error(
      "[linear] Disabled: set all of LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET and LINEAR_WEBHOOK_SECRET (or none).",
    );
    return null;
  }

  const rawPort = env.LINEAR_WEBHOOK_PORT?.trim();
  let port = DEFAULT_LINEAR_PORT;
  if (rawPort) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      console.error(`[linear] Disabled: LINEAR_WEBHOOK_PORT must be a port number, got "${rawPort}".`);
      return null;
    }
    port = parsed;
  }

  const tools = (env.LINEAR_AGENT_TOOLS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return { clientId, clientSecret, webhookSecret, port, tools };
}
