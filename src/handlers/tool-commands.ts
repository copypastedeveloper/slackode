import type { WebClient } from "@slack/web-api";
import {
  getToolFromDb, getAllTools, upsertTool, removeTool,
  setToolKey, setToolEnabled, getToolKey,
  type UpsertToolOpts,
} from "../sessions.js";
import { restartServer } from "../opencode-server.js";

// ── Conversational state machine for `tool add` ──

interface AddState {
  step: "description" | "instruction" | "mcp_type" | "mcp_url" | "mcp_command";
  name: string;
  description?: string;
  instruction?: string;
  mcpType?: string;
  expiresAt: number;
}

const addStates = new Map<string, AddState>();
const STATE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function stateKey(channelId: string, userId: string): string {
  return `${channelId}:${userId}`;
}

function cleanExpired(): void {
  const now = Date.now();
  for (const [key, state] of addStates) {
    if (now > state.expiresAt) addStates.delete(key);
  }
}

/**
 * Try to advance the `tool add` conversation.
 * Returns a reply string if this message is part of an active add flow, null otherwise.
 */
export function advanceToolAdd(
  channelId: string,
  userId: string,
  text: string,
): string | null {
  cleanExpired();
  const key = stateKey(channelId, userId);
  const state = addStates.get(key);
  if (!state) return null;

  const input = text.trim();
  if (!input) return null;

  // Refresh TTL on each interaction
  state.expiresAt = Date.now() + STATE_TTL_MS;

  switch (state.step) {
    case "description": {
      state.description = input;
      state.step = "instruction";
      return "What instructions should the agent follow when using this tool?";
    }
    case "instruction": {
      state.instruction = input;
      state.step = "mcp_type";
      return "MCP server type?\n• `remote` — connect to a hosted MCP endpoint\n• `local` — run a command (e.g. npx)";
    }
    case "mcp_type": {
      const lower = input.toLowerCase();
      if (lower !== "remote" && lower !== "local") {
        return "Please answer `remote` or `local`.";
      }
      state.mcpType = lower;
      if (lower === "remote") {
        state.step = "mcp_url";
        return "MCP server URL?";
      }
      state.step = "mcp_command";
      return "MCP command? (space-separated, e.g. `npx -y @sentry/mcp-server`)";
    }
    case "mcp_url": {
      const opts: UpsertToolOpts = {
        name: state.name,
        description: state.description!,
        instruction: state.instruction!,
        mcpType: "remote",
        mcpUrl: input,
        mcpHeaderAuth: "Bearer",
      };
      upsertTool(opts);
      addStates.delete(key);
      return (
        `Tool \`${state.name}\` registered.\n` +
        `Run \`tool set-key ${state.name} <api-key>\` to configure the API key.`
      );
    }
    case "mcp_command": {
      const parts = input.split(/\s+/);
      const opts: UpsertToolOpts = {
        name: state.name,
        description: state.description!,
        instruction: state.instruction!,
        mcpType: "local",
        mcpCommand: parts,
        mcpEnvPassthrough: true,
        envVar: `${state.name.toUpperCase().replace(/-/g, "_")}_API_KEY`,
      };
      upsertTool(opts);
      addStates.delete(key);
      return (
        `Tool \`${state.name}\` registered.\n` +
        `Run \`tool set-key ${state.name} <api-key>\` to configure the API key.`
      );
    }
    default:
      addStates.delete(key);
      return null;
  }
}

/**
 * Handle `tool <subcommand>` commands from Slack.
 * Returns a reply string (possibly async due to restart), or null if not a tool command.
 *
 * Pass the WebClient + channel so we can post restart status messages.
 */
export async function handleToolCommand(
  command: string,
  channelId: string,
  userId: string,
  threadTs: string,
  client: WebClient,
): Promise<string | null> {
  const match = command.match(/^tool\s+(.+)$/i);
  if (!match) return null;

  const sub = match[1].trim();

  // ── tool list ──
  if (/^list$/i.test(sub)) {
    const tools = getAllTools();
    if (tools.length === 0) {
      return "No tools registered. Use `tool add <name>` to add one.";
    }
    const lines = tools.map((t) => {
      const hasKey = !!(t.encrypted_key || (t.env_var && process.env[t.env_var!]));
      const keyBadge = hasKey ? "key: \u2713" : "key: \u2717";
      const statusBadge = t.enabled ? "enabled" : "disabled";
      return `\u2022 \`${t.name}\` \u2014 ${t.description} [${keyBadge}] [${statusBadge}]`;
    });
    return `*Registered tools:*\n${lines.join("\n")}`;
  }

  // ── tool add <name> ──
  const addMatch = sub.match(/^add\s+(\S+)$/i);
  if (addMatch) {
    const name = addMatch[1].toLowerCase();
    if (getToolFromDb(name)) {
      return `Tool \`${name}\` already exists. Use \`tool remove ${name}\` first to re-register.`;
    }
    const key = stateKey(channelId, userId);
    addStates.set(key, {
      step: "description",
      name,
      expiresAt: Date.now() + STATE_TTL_MS,
    });
    return (
      `Setting up *${name}*. I'll ask a few questions.\n` +
      `What does this tool do? (short description)`
    );
  }

  // ── tool remove <name> ──
  const removeMatch = sub.match(/^remove\s+(\S+)$/i);
  if (removeMatch) {
    const name = removeMatch[1].toLowerCase();
    const tool = getToolFromDb(name);
    if (!tool) return `Tool \`${name}\` not found.`;

    const wasEnabled = tool.enabled === 1 && !!(getToolKey(tool));
    removeTool(name);

    if (wasEnabled) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Tool \`${name}\` removed. _Reconfiguring... this takes a few seconds._`,
      });
      const elapsed = await restartServer();
      return `Tools updated. OpenCode restarted. _(took ${elapsed.toFixed(1)}s)_`;
    }

    return `Tool \`${name}\` removed.`;
  }

  // ── tool set-key <name> <key> ──
  const setKeyMatch = sub.match(/^set-key\s+(\S+)\s+(\S+)$/i);
  if (setKeyMatch) {
    const name = setKeyMatch[1].toLowerCase();
    const apiKey = setKeyMatch[2];
    const tool = getToolFromDb(name);
    if (!tool) return `Tool \`${name}\` not found. Register it first with \`tool add ${name}\`.`;

    setToolKey(name, apiKey);

    if (tool.enabled) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `API key stored for \`${name}\`. _Reconfiguring... this takes a few seconds._\n:warning: *Delete your message containing the API key for security.*`,
      });
      const elapsed = await restartServer();
      return `Tools updated. OpenCode restarted. _(took ${elapsed.toFixed(1)}s)_`;
    }

    return `API key stored for \`${name}\`.\n:warning: *Delete your message containing the API key for security.*`;
  }

  // ── tool enable <name> ──
  const enableMatch = sub.match(/^enable\s+(\S+)$/i);
  if (enableMatch) {
    const name = enableMatch[1].toLowerCase();
    const tool = getToolFromDb(name);
    if (!tool) return `Tool \`${name}\` not found.`;
    if (tool.enabled) return `Tool \`${name}\` is already enabled.`;

    setToolEnabled(name, true);

    if (getToolKey({ ...tool, enabled: 1 })) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Tool \`${name}\` enabled. _Reconfiguring... this takes a few seconds._`,
      });
      const elapsed = await restartServer();
      return `Tools updated. OpenCode restarted. _(took ${elapsed.toFixed(1)}s)_`;
    }

    return `Tool \`${name}\` enabled. (No API key set — run \`tool set-key ${name} <key>\` to activate.)`;
  }

  // ── tool disable <name> ──
  const disableMatch = sub.match(/^disable\s+(\S+)$/i);
  if (disableMatch) {
    const name = disableMatch[1].toLowerCase();
    const tool = getToolFromDb(name);
    if (!tool) return `Tool \`${name}\` not found.`;
    if (!tool.enabled) return `Tool \`${name}\` is already disabled.`;

    setToolEnabled(name, false);

    if (getToolKey(tool)) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Tool \`${name}\` disabled. _Reconfiguring... this takes a few seconds._`,
      });
      const elapsed = await restartServer();
      return `Tools updated. OpenCode restarted. _(took ${elapsed.toFixed(1)}s)_`;
    }

    return `Tool \`${name}\` disabled.`;
  }

  return [
    "Unrecognized tool command. Available commands:",
    "\u2022 `tool list` \u2014 show all registered tools",
    "\u2022 `tool add <name>` \u2014 register a new tool (conversational)",
    "\u2022 `tool remove <name>` \u2014 remove a tool",
    "\u2022 `tool set-key <name> <key>` \u2014 set the API key for a tool",
    "\u2022 `tool enable <name>` \u2014 enable a disabled tool",
    "\u2022 `tool disable <name>` \u2014 disable a tool",
  ].join("\n");
}
