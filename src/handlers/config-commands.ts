import type { WebClient } from "@slack/web-api";
import {
  getChannelAgent, setChannelAgent, clearChannelAgent, listChannelAgents,
  getChannelTools, setChannelTools, clearChannelTools, listChannelTools,
  getChannelConfig, setChannelConfig, clearChannelConfig, listChannelConfigs,
  getChannelRepo, setChannelRepo, clearChannelRepo, listChannelRepos,
  getRepo, getDefaultRepo, getAllRepos,
} from "../sessions.js";
import { getKnownTools, MAX_CUSTOM_PROMPT_LENGTH } from "../tools.js";

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
 * Any command may carry `--channel <#chan>` to target a channel other than the
 * one the message was sent in (the bot need not be a member — channel config
 * is DB-only).
 *
 * Returns the reply text if it was a config command, or null if not.
 * Shared between mention and DM handlers.
 */
export async function handleConfigCommand(
  command: string,
  channelId: string,
  channelName: string,
  userId: string,
  client?: WebClient,
): Promise<string | null> {
  const match = command.match(/^config\s+(.+)$/i);
  if (!match) return null;

  let subcommand = match[1].trim();

  // Optional cross-channel targeting: `--channel <#C0123|name>` anywhere in the command.
  const channelFlag = subcommand.match(/\s*--channel\s+<#([A-Z0-9]+)(?:\|([^>]*))?>\s*/i);
  if (channelFlag) {
    channelId = channelFlag[1];
    channelName = channelFlag[2] || (await resolveChannelName(client, channelId)) || channelId;
    subcommand = subcommand.replace(channelFlag[0], " ").trim();
  }

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

  // config set tools <tool1,tool2> (allows spaces around commas)
  const setToolsMatch = subcommand.match(/^set\s+tools?\s+(.+)$/i);
  if (setToolsMatch) {
    const requested = setToolsMatch[1].split(/[\s,]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
    const knownTools = getKnownTools();
    const invalid = requested.filter((t) => !(t in knownTools));
    if (invalid.length > 0) {
      const available = Object.keys(knownTools).map((k) => `\`${k}\``).join(", ");
      return `Unknown tool${invalid.length > 1 ? "s" : ""}: ${invalid.map((t) => `\`${t}\``).join(", ")}. Available tools: ${available}`;
    }
    const unique = [...new Set(requested)].sort();
    if (unique.length === 0) {
      const available = Object.keys(knownTools).map((k) => `\`${k}\``).join(", ");
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
    const lines = Object.entries(getKnownTools()).map(([name, desc]) => `• \`${name}\` — ${desc}`);
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

  // --- Repo commands ---

  // config set repo <name>
  const setRepoMatch = subcommand.match(/^set\s+repo\s+(\S+)$/i);
  if (setRepoMatch) {
    const repoName = setRepoMatch[1];
    const repo = getRepo(repoName);
    if (!repo) {
      const available = getAllRepos().map((r) => `\`${r.name}\``).join(", ");
      return `Repo \`${repoName}\` not found.${available ? ` Available repos: ${available}` : " No repos registered yet. Use `repo add` to register one."}`;
    }
    setChannelRepo(channelId, channelName, repoName);
    return `Repo set to \`${repoName}\`. Questions here will now focus on the ${repoName} codebase.`;
  }

  // config get repo
  if (/^get\s+repo$/i.test(subcommand)) {
    const repoName = getChannelRepo(channelId);
    if (repoName) {
      return `Using repo \`${repoName}\`.`;
    }
    const defaultRepo = getDefaultRepo();
    return `No repo configured — using the default${defaultRepo ? ` (\`${defaultRepo.name}\`)` : ""}.`;
  }

  // config clear repo
  if (/^clear\s+repo$/i.test(subcommand)) {
    const removed = clearChannelRepo(channelId);
    if (removed) {
      return `Repo configuration cleared. Using the default repo.`;
    }
    return `No repo was configured.`;
  }

  // config list repos
  if (/^list\s+repos?$/i.test(subcommand)) {
    const rows = listChannelRepos();
    if (rows.length === 0) {
      return "No channel-specific repos configured. All channels are using the default repo.";
    }
    const lines = rows.map((r) => `• #${r.channel_name} → \`${r.repo_name}\``);
    return `*Channel repo mappings:*\n${lines.join("\n")}`;
  }

  // config list channels — unified view of every channel with any custom config.
  // Joins agent / tools / repo / prompt by channel_id; channels with no overrides at all
  // are not listed (they're implicitly using defaults).
  if (/^list\s+channels?$/i.test(subcommand)) {
    type ChannelSummary = {
      name: string;
      agent?: string;
      tools?: string;
      repo?: string;
      prompt?: string;
      promptBy?: string;
    };
    const byId = new Map<string, ChannelSummary>();
    const upsert = (id: string, name: string, patch: Partial<ChannelSummary>): void => {
      const existing = byId.get(id) ?? { name };
      if (name) existing.name = name;
      Object.assign(existing, patch);
      byId.set(id, existing);
    };
    for (const r of listChannelAgents()) upsert(r.channel_id, r.channel_name, { agent: r.agent });
    for (const r of listChannelTools()) upsert(r.channel_id, r.channel_name, { tools: r.tools });
    for (const r of listChannelRepos()) upsert(r.channel_id, r.channel_name, { repo: r.repo_name });
    for (const r of listChannelConfigs()) upsert(r.channel_id, "", { prompt: r.custom_prompt, promptBy: r.configured_by });

    if (byId.size === 0) {
      return "No channels have custom configuration. Every channel is using defaults.";
    }
    const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
    const sorted = [...byId.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));
    const blocks = sorted.map(([id, c]) => {
      const lines = [`*#${c.name || id}*`];
      if (c.agent) lines.push(`  agent: \`${c.agent}\``);
      if (c.tools) lines.push(`  tools: ${c.tools.split(",").map((t) => `\`${t}\``).join(", ")}`);
      if (c.repo) lines.push(`  repo: \`${c.repo}\``);
      if (c.prompt) {
        const by = c.promptBy ? ` _(set by <@${c.promptBy}>)_` : "";
        lines.push(`  prompt: ${truncate(c.prompt, 120)}${by}`);
      }
      return lines.join("\n");
    });
    return `*Channel configs (${byId.size}):*\n${blocks.join("\n\n")}`;
  }

  // config available repos
  if (/^available\s+repos?$/i.test(subcommand)) {
    const repos = getAllRepos();
    if (repos.length === 0) {
      return "No repos registered. Use `repo add <name> <url>` to add one.";
    }
    const lines = repos.map((r) => {
      const badges = [r.is_default ? "default" : "", r.enabled ? "enabled" : "disabled"].filter(Boolean).join(", ");
      return `• \`${r.name}\` — ${r.url} [${badges}]`;
    });
    return `*Available repos:*\n${lines.join("\n")}`;
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
    "• `config set repo <name>`",
    "• `config get repo`",
    "• `config clear repo`",
    "• `config list repos`",
    "• `config available repos`",
    "• `config list channels` — unified per-channel view (agent + tools + repo + prompt)",
    "• Add `--channel <#chan>` to any command to configure a channel you're not in",
  ].join("\n");
}

/** Best-effort display name for a channel (may fail for private channels the bot isn't in). */
async function resolveChannelName(client: WebClient | undefined, channelId: string): Promise<string | undefined> {
  if (!client) return undefined;
  try {
    const info = await client.conversations.info({ channel: channelId });
    return info.channel?.name;
  } catch {
    return undefined;
  }
}
