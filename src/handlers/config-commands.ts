import {
  getChannelAgent, setChannelAgent, clearChannelAgent, listChannelAgents,
  getChannelTools, setChannelTools, clearChannelTools, listChannelTools,
  getChannelConfig, setChannelConfig, clearChannelConfig,
} from "../sessions.js";
import { KNOWN_TOOLS, MAX_CUSTOM_PROMPT_LENGTH } from "../tools.js";

/**
 * Handle config commands like:
 *   config set agent <name>
 *   config get agent
 *   config clear agent
 *   config list agents
 *   config set tools <tool1,tool2>
 *   config get tools
 *   config clear tools
 *   config list tools
 *   config available tools
 *   config set prompt <text>
 *   config get prompt
 *   config clear prompt
 *
 * Returns the reply text if it was a config command, or null if not.
 * Shared between mention and DM handlers.
 */
export async function handleConfigCommand(
  command: string,
  channelId: string,
  channelName: string,
  userId: string,
): Promise<string | null> {
  const match = command.match(/^config\s+(.+)$/i);
  if (!match) return null;

  const subcommand = match[1].trim();

  // config set agent <name>
  const setMatch = subcommand.match(/^set\s+agent\s+(\S+)$/i);
  if (setMatch) {
    const agent = setMatch[1];
    setChannelAgent(channelId, channelName, agent);
    return `Agent set to \`${agent}\`. Messages here will now use the \`${agent}\` agent profile.`;
  }

  // config get agent
  if (/^get\s+agent$/i.test(subcommand)) {
    const agent = getChannelAgent(channelId);
    if (agent) {
      return `Using the \`${agent}\` agent profile.`;
    }
    return `No agent configured — using the default.`;
  }

  // config clear agent
  if (/^clear\s+agent$/i.test(subcommand)) {
    const removed = clearChannelAgent(channelId);
    if (removed) {
      return `Agent configuration cleared. Using the default agent.`;
    }
    return `No agent was configured.`;
  }

  // config list agents
  if (/^list\s+agents?$/i.test(subcommand)) {
    const rows = listChannelAgents();
    if (rows.length === 0) {
      return "No channel-specific agents configured. All channels are using the default agent.";
    }
    const lines = rows.map((r) => `• #${r.channel_name} → \`${r.agent}\``);
    return `*Channel agent mappings:*\n${lines.join("\n")}`;
  }

  // --- Tool commands ---

  // config set tools <tool1,tool2>
  const setToolsMatch = subcommand.match(/^set\s+tools?\s+(\S+)$/i);
  if (setToolsMatch) {
    const requested = setToolsMatch[1].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    const invalid = requested.filter((t) => !(t in KNOWN_TOOLS));
    if (invalid.length > 0) {
      const available = Object.keys(KNOWN_TOOLS).map((k) => `\`${k}\``).join(", ");
      return `Unknown tool${invalid.length > 1 ? "s" : ""}: ${invalid.map((t) => `\`${t}\``).join(", ")}. Available tools: ${available}`;
    }
    const unique = [...new Set(requested)].sort();
    if (unique.length === 0) {
      const available = Object.keys(KNOWN_TOOLS).map((k) => `\`${k}\``).join(", ");
      return `No valid tools specified. Please provide at least one tool name. Available tools: ${available}`;
    }
    setChannelTools(channelId, channelName, unique);
    return `Tools set to ${unique.map((t) => `\`${t}\``).join(", ")}. Messages here can now reference ${unique.join(" and ")} data.`;
  }

  // config get tools
  if (/^get\s+tools?$/i.test(subcommand)) {
    const tools = getChannelTools(channelId);
    if (tools && tools.length > 0) {
      return `Tools enabled: ${tools.map((t) => `\`${t}\``).join(", ")}`;
    }
    return `No extra tools configured — using codebase Q&A only.`;
  }

  // config clear tools
  if (/^clear\s+tools?$/i.test(subcommand)) {
    const removed = clearChannelTools(channelId);
    if (removed) {
      return `Tools cleared. Using codebase Q&A only.`;
    }
    return `No tools were configured.`;
  }

  // config list tools
  if (/^list\s+tools?$/i.test(subcommand)) {
    const rows = listChannelTools();
    if (rows.length === 0) {
      return "No channel-specific tools configured.";
    }
    const lines = rows.map((r) => `• #${r.channel_name} → ${r.tools.split(",").map((t: string) => `\`${t}\``).join(", ")}`);
    return `*Channel tool mappings:*\n${lines.join("\n")}`;
  }

  // config available tools
  if (/^available\s+tools?$/i.test(subcommand)) {
    const lines = Object.entries(KNOWN_TOOLS).map(([name, desc]) => `• \`${name}\` — ${desc}`);
    return `*Available tools:*\n${lines.join("\n")}`;
  }

  // --- Custom prompt commands ---

  // config set prompt <text>
  const setPromptMatch = subcommand.match(/^set\s+prompt\s+(.+)$/is);
  if (setPromptMatch) {
    const prompt = setPromptMatch[1].trim();
    if (prompt.length > MAX_CUSTOM_PROMPT_LENGTH) {
      return `Custom instructions must be ${MAX_CUSTOM_PROMPT_LENGTH} characters or fewer (yours: ${prompt.length}).`;
    }
    setChannelConfig(channelId, prompt, userId);
    return `Custom instructions set:\n> ${prompt}`;
  }

  // config get prompt
  if (/^(get|show)\s+prompt$/i.test(subcommand)) {
    const config = getChannelConfig(channelId);
    if (config) {
      return `Custom instructions (set by <@${config.configuredBy}>):\n> ${config.customPrompt}`;
    }
    return `No custom instructions set.`;
  }

  // config clear prompt
  if (/^clear\s+prompt$/i.test(subcommand)) {
    clearChannelConfig(channelId);
    return `Custom instructions cleared.`;
  }

  return [
    "Unrecognized config command. Available config commands:",
    "• `config set agent <name>`",
    "• `config get agent`",
    "• `config clear agent`",
    "• `config list agents`",
    "• `config set tools <tool1,tool2>`",
    "• `config get tools`",
    "• `config clear tools`",
    "• `config list tools`",
    "• `config available tools`",
    "• `config set prompt <instructions>`",
    "• `config get prompt` / `config show prompt`",
    "• `config clear prompt`",
  ].join("\n");
}
