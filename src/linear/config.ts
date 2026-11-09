export interface LinearConfig {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  /** Webhook listener port (also serves GET /health). */
  port: number;
  /** MCP tools the Linear agent may use, e.g. ["linear", "sentry"]. */
  tools: string[];
}

/** Pseudo channel ID Linear conversations are recorded under (sessions, turns, repo routing). */
export const LINEAR_CHANNEL_ID = "linear";
/** OpenCode agent the Linear surface runs as (generated in opencode-config.ts). */
export const LINEAR_AGENT_NAME = "linear";

/** The Linear config, or null (Linear disabled) unless all three credentials are set. */
export function readLinearConfig(env: NodeJS.ProcessEnv = process.env): LinearConfig | null {
  const clientId = env.LINEAR_CLIENT_ID?.trim();
  const clientSecret = env.LINEAR_CLIENT_SECRET?.trim();
  const webhookSecret = env.LINEAR_WEBHOOK_SECRET?.trim();
  if (!clientId || !clientSecret || !webhookSecret) {
    if (clientId || clientSecret || webhookSecret) {
      console.error("[linear] Disabled: set all of LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET and LINEAR_WEBHOOK_SECRET.");
    }
    return null;
  }
  return {
    clientId,
    clientSecret,
    webhookSecret,
    port: Number(env.LINEAR_WEBHOOK_PORT) || 8080,
    tools: (env.LINEAR_AGENT_TOOLS ?? "").split(",").map((t) => t.trim()).filter(Boolean),
  };
}
