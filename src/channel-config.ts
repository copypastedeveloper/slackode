/**
 * Channel-to-agent mapping.
 *
 * Configured via the CHANNEL_AGENTS environment variable — a JSON object
 * mapping Slack channel names (without #) to OpenCode agent profile names
 * defined in opencode.json.
 *
 * Example:
 *   CHANNEL_AGENTS='{"incidents":"incidents","planning":"planning"}'
 *
 * Channels not in the map fall back to the default agent.
 */

const channelAgents: Map<string, string> = new Map();

const raw = process.env.CHANNEL_AGENTS;
if (raw) {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [channel, agent] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof agent === "string" && agent) {
          channelAgents.set(channel.replace(/^#/, ""), agent);
        }
      }
      if (channelAgents.size > 0) {
        console.log(
          `[channel-config] Loaded agent mappings: ${[...channelAgents.entries()].map(([c, a]) => `#${c} → ${a}`).join(", ")}`
        );
      }
    } else {
      console.warn("[channel-config] CHANNEL_AGENTS must be a JSON object, got:", typeof parsed);
    }
  } catch (err) {
    console.warn("[channel-config] Failed to parse CHANNEL_AGENTS:", (err as Error).message);
  }
}

/**
 * Returns the agent profile name for a channel, or undefined to use the default.
 */
export function getAgentForChannel(channelName: string): string | undefined {
  return channelAgents.get(channelName.replace(/^#/, ""));
}
