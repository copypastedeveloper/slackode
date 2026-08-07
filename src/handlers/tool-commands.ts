import type { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  getToolFromDb, getAllTools, upsertTool, removeTool,
  setToolKey, setToolEnabled, getToolKey, getOAuthAccessToken,
  clearOAuthState, clearOAuthTokens, getOAuthState, upsertOAuthClientInfo, setOAuthPublic,
  setToolAllowedTools, parseAllowedTools,
  type UpsertToolOpts, type AuthType,
} from "../sessions.js";
import { restartServer } from "../opencode-server.js";
import { MCPOAuthProvider } from "../mcp/oauth-provider.js";
import { configureButtonBlock } from "./tool-configure.js";
import { Action } from "../constants.js";

/** Would this tool be included in the generated config? */
function isToolActive(tool: { enabled: number; mcp_type: string; auth_type: AuthType }, key: string | undefined): boolean {
  if (!tool.enabled) return false;
  if (tool.auth_type === "oauth") {
    return true; // OAuth tools are "active" if enabled — config gen skips if no token
  }
  // Remote tools require a key; local tools work without one.
  return tool.mcp_type === "local" || !!key;
}

/** Check if an OAuth tool has a valid access token. */
function isOAuthToolActive(toolName: string): boolean {
  return !!getOAuthAccessToken(toolName);
}

// ── Conversational state machine for `tool add` ──

interface AddState {
  step: "description" | "instruction" | "mcp_type" | "mcp_url" | "auth_type" | "oauth_client" | "mcp_command" | "needs_key";
  name: string;
  description?: string;
  instruction?: string;
  mcpType?: string;
  mcpUrl?: string;
  mcpCommand?: string[];
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

interface OAuthFlowResult {
  text: string;
  /** If set, post this as a separate message with a "Complete Authorization" button. */
  authButton?: { toolName: string; authUrl: string };
  /** True when the flow threw (e.g. the provider doesn't support DCR). */
  failed?: boolean;
}

/**
 * Initiate the OAuth flow for a tool and return a message + optional button data.
 */
async function initiateOAuthFlow(toolName: string, serverUrl: string): Promise<OAuthFlowResult> {
  const provider = new MCPOAuthProvider(toolName);

  let authUrl: string | null = null;
  provider.onAuthRedirect = (_name, url) => {
    authUrl = url.toString();
  };

  try {
    const result = await auth(provider, { serverUrl });

    if (result === "AUTHORIZED") {
      return { text: `Tool \`${toolName}\` is already authorized. _Reconfiguring..._` };
    }

    if (authUrl) {
      return {
        text: (
          `Tool \`${toolName}\` requires OAuth authorization.\n` +
          `1. <${authUrl}|Click here to authenticate>\n` +
          `2. After approving, copy the code and state from the redirect page.\n` +
          `3. Click *Complete Authorization* below to enter them.`
        ),
        authButton: { toolName, authUrl },
      };
    }

    return { text: `OAuth flow initiated for \`${toolName}\`, but no auth URL was generated. Check the MCP server URL.` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      text:
        `OAuth flow failed for \`${toolName}\`: ${msg}\n` +
        `_If the provider doesn't support dynamic client registration, register a client with the provider manually, then run \`tool set-client ${toolName} <client-id> [client-secret]\` and \`tool auth ${toolName}\`._`,
      failed: true,
    };
  }
}

/**
 * Post the OAuth flow message with an optional "Complete Authorization" button.
 */
async function postOAuthFlowMessage(
  result: OAuthFlowResult,
  client: WebClient,
  channelId: string,
  threadTs: string,
): Promise<void> {
  if (result.authButton) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: result.text,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: result.text },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Complete Authorization" },
              action_id: Action.OAUTH_COMPLETE,
              value: result.authButton.toolName,
              style: "primary",
            },
          ],
        },
      ],
    });
  } else {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: result.text,
    });
  }
}

/**
 * Try to advance the `tool add` conversation.
 * Returns a reply string if this message is part of an active add flow, null otherwise.
 */
export async function advanceToolAdd(
  channelId: string,
  userId: string,
  text: string,
  client: WebClient,
  threadTs: string,
): Promise<string | null> {
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
      // Slack auto-links URLs with angle brackets — strip them
      const url = input.replace(/^<|>$/g, "");
      state.mcpUrl = url;
      state.step = "auth_type";
      return "Authentication type?\n• `api-key` — static API key (Bearer token)\n• `oauth` — OAuth 2.0 flow";
    }
    case "auth_type": {
      const lower = input.toLowerCase().replace(/\s+/g, "-");
      if (lower !== "api-key" && lower !== "oauth") {
        return "Please answer `api-key` or `oauth`.";
      }
      if (lower === "oauth") {
        const opts: UpsertToolOpts = {
          name: state.name,
          description: state.description!,
          instruction: state.instruction!,
          mcpType: "remote",
          mcpUrl: state.mcpUrl!,
          authType: "oauth",
        };
        upsertTool(opts);

        // Initiate OAuth flow and post message with button
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: `Tool \`${state.name}\` registered (OAuth).`,
        });
        const result = await initiateOAuthFlow(state.name, state.mcpUrl!);
        if (result.failed) {
          // Likely no dynamic client registration — ask for pre-registered credentials.
          state.step = "oauth_client";
          return (
            `Automatic client registration failed:\n> ${result.text.split("\n")[0]}\n` +
            `If this provider requires a manually registered OAuth app, create one upstream ` +
            `(redirect URL: \`${new MCPOAuthProvider(state.name).redirectUrl}\`), then paste:\n` +
            "`<client-id> [client-secret]` — or `cancel` to stop here."
          );
        }
        addStates.delete(key);
        await postOAuthFlowMessage(result, client, channelId, threadTs);
        return "__handled__";
      }
      // api-key flow
      const opts: UpsertToolOpts = {
        name: state.name,
        description: state.description!,
        instruction: state.instruction!,
        mcpType: "remote",
        mcpUrl: state.mcpUrl!,
        mcpHeaderAuth: "Bearer",
      };
      upsertTool(opts);
      addStates.delete(key);
      return (
        `Tool \`${state.name}\` registered.\n` +
        `Run \`tool set-key ${state.name} <api-key>\` to configure the API key.`
      );
    }
    case "oauth_client": {
      if (/^cancel$/i.test(input)) {
        addStates.delete(key);
        return (
          `Stopped. Tool \`${state.name}\` is registered but not authorized.\n` +
          `Later, run \`tool set-client ${state.name} <client-id> [client-secret]\` and \`tool auth ${state.name}\`.`
        );
      }
      const parts = input.split(/\s+/);
      if (parts.length > 2) {
        return "Please paste `<client-id> [client-secret]` (or `cancel`).";
      }
      const [clientId, clientSecret] = parts;
      // No secret ⇒ public/PKCE-only client.
      upsertOAuthClientInfo(state.name, { clientId, clientSecret: clientSecret ?? null, manual: true, isPublic: !clientSecret });

      const result = await initiateOAuthFlow(state.name, state.mcpUrl!);
      if (result.failed) {
        // Keep the state so the admin can re-paste corrected credentials.
        return (
          `Still failing:\n> ${result.text.split("\n")[0]}\n` +
          "Check the client id/secret and paste again, or `cancel`."
        );
      }
      addStates.delete(key);
      await postOAuthFlowMessage(result, client, channelId, threadTs);
      if (clientSecret) {
        await client.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: ":warning: *Delete your message containing the client secret for security.*",
        });
      }
      return "__handled__";
    }
    case "mcp_command": {
      state.mcpCommand = input.split(/\s+/);
      state.step = "needs_key";
      return "Does this tool require an API key? (`yes` or `no`)";
    }
    case "needs_key": {
      const lower = input.toLowerCase();
      if (lower !== "yes" && lower !== "no" && lower !== "y" && lower !== "n") {
        return "Please answer `yes` or `no`.";
      }
      const needsKey = lower === "yes" || lower === "y";
      const opts: UpsertToolOpts = {
        name: state.name,
        description: state.description!,
        instruction: state.instruction!,
        mcpType: "local",
        mcpCommand: state.mcpCommand!,
        ...(needsKey && {
          mcpEnvPassthrough: true,
          envVar: `${state.name.toUpperCase().replace(/-/g, "_")}_API_KEY`,
        }),
      };
      upsertTool(opts);
      addStates.delete(key);
      if (needsKey) {
        return (
          `Tool \`${state.name}\` registered.\n` +
          `Run \`tool set-key ${state.name} <api-key>\` to configure the API key.`
        );
      }
      restartServer();
      return `Tool \`${state.name}\` registered. _Reconfiguring..._`;
    }
    default:
      addStates.delete(key);
      return null;
  }
}

/**
 * Complete an OAuth token exchange given the authorization code and state.
 * Called from the modal submission handler.
 */
export async function completeOAuthExchange(
  toolName: string,
  code: string,
  oauthState: string | undefined,
  client: WebClient,
  channelId: string,
  threadTs: string,
): Promise<void> {
  const tool = getToolFromDb(toolName);
  if (!tool?.mcp_url) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Tool \`${toolName}\` not found or has no MCP URL.`,
    });
    return;
  }

  const provider = new MCPOAuthProvider(toolName);

  // Look up the PKCE code_verifier from the pending state
  if (oauthState) {
    const pending = MCPOAuthProvider.findByOAuthState(oauthState);
    if (pending?.codeVerifier) {
      provider.setCodeVerifierOverride(pending.codeVerifier);
    }
  }

  try {
    await auth(provider, {
      serverUrl: tool.mcp_url,
      authorizationCode: code,
    });
    console.log(`[oauth:${toolName}] Token exchange complete.`);

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `OAuth tokens stored for \`${toolName}\`. _Reconfiguring... this takes a few seconds._`,
    });
    const elapsed = await restartServer();
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Tool \`${toolName}\` authorized. OpenCode restarted. _(took ${elapsed.toFixed(1)}s)_`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `Tool \`${toolName}\` authorized. OpenCode restarted. _(took ${elapsed.toFixed(1)}s)_\nPick which of its tools to expose:` } },
        configureButtonBlock(toolName),
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Token exchange failed for \`${toolName}\`: ${msg}\nTry \`tool auth ${toolName}\` to start over.`,
    });
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
    const blocks: KnownBlock[] = [
      { type: "section", text: { type: "mrkdwn", text: "*Registered tools:*" } },
    ];
    for (const t of tools) {
      let authBadge: string;
      let authed: boolean;
      if (t.auth_type === "oauth") {
        authed = isOAuthToolActive(t.name);
        authBadge = authed ? "oauth: \u2713" : "oauth: \u2717";
      } else {
        authed = !!(t.encrypted_key || (t.env_var && process.env[t.env_var!]));
        authBadge = authed ? "key: \u2713" : "key: \u2717";
      }
      const statusBadge = t.enabled ? "enabled" : "disabled";
      const allowed = parseAllowedTools(t.allowed_tools);
      const toolsBadge = allowed.length > 0 ? ` [tools: ${allowed.join(", ")}]` : " [tools: all]";
      const line = `\u2022 \`${t.name}\` \u2014 ${t.description} [${authBadge}] [${statusBadge}]${toolsBadge}`;
      // Only enabled + authenticated servers can be introspected for their tool list.
      const canConfigure = t.enabled && authed;
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: line },
        ...(canConfigure ? { accessory: { type: "button", text: { type: "plain_text", text: "Configure tools" }, action_id: Action.TOOL_CONFIGURE, value: t.name } } : {}),
      });
    }
    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "Registered tools", blocks });
    return null;
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

  // ── tool auth <name> [--public] ──
  // --public registers a public/PKCE-only client via DCR (no client secret).
  const authMatch = sub.match(/^auth\s+(\S+)(?:\s+(--public))?$/i);
  if (authMatch) {
    const name = authMatch[1].toLowerCase();
    const wantPublic = !!authMatch[2];
    const tool = getToolFromDb(name);
    if (!tool) return `Tool \`${name}\` not found.`;
    if (tool.auth_type !== "oauth") {
      return `Tool \`${name}\` uses API key auth, not OAuth. Use \`tool set-key ${name} <key>\` instead.`;
    }
    if (!tool.mcp_url) {
      return `Tool \`${name}\` has no MCP URL configured.`;
    }

    // Clear existing OAuth state for a fresh re-auth — but preserve
    // manually configured client credentials (non-DCR providers).
    const wasPublic = !!getOAuthState(name)?.oauth_public;
    if (getOAuthState(name)?.client_manual) {
      clearOAuthTokens(name);
    } else {
      clearOAuthState(name);
    }
    // Re-apply the public flag before DCR so the client registers with
    // token_endpoint_auth_method "none" (preserve it across re-auth too).
    if (wantPublic || wasPublic) setOAuthPublic(name, true);

    const result = await initiateOAuthFlow(name, tool.mcp_url);
    await postOAuthFlowMessage(result, client, channelId, threadTs);
    return null; // Already posted
  }

  // ── tool set-client <name> <client-id> [client-secret] ──
  // For OAuth providers that don't support dynamic client registration:
  // store a pre-registered client id/secret to be used instead of DCR.
  const setClientMatch = sub.match(/^set-client\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/i);
  if (setClientMatch) {
    const name = setClientMatch[1].toLowerCase();
    const clientId = setClientMatch[2];
    const clientSecret = setClientMatch[3];
    const tool = getToolFromDb(name);
    if (!tool) return `Tool \`${name}\` not found. Register it first with \`tool add ${name}\`.`;
    if (tool.auth_type !== "oauth") {
      return `Tool \`${name}\` uses API key auth, not OAuth. Use \`tool set-key ${name} <key>\` instead.`;
    }

    // No secret ⇒ public/PKCE-only client; a secret ⇒ confidential client.
    const isPublic = !clientSecret;
    upsertOAuthClientInfo(name, { clientId, clientSecret: clientSecret ?? null, manual: true, isPublic });

    return (
      `Client ${isPublic ? "ID stored for `" + name + "` (public/PKCE — no secret)" : "credentials stored for `" + name + "`"} (dynamic registration will be skipped).\n` +
      `Run \`tool auth ${name}\` to authorize.` +
      (clientSecret ? "\n:warning: *Delete your message containing the client secret for security.*" : "")
    );
  }

  // ── tool allow <name> <tool1,tool2,... | all> ──
  // Global per-server tool allowlist (applies everywhere the server is enabled;
  // NOT per-channel). `all`/`*` clears it so every tool is available.
  const allowMatch = sub.match(/^allow\s+(\S+)\s+(.+)$/i);
  if (allowMatch) {
    const name = allowMatch[1].toLowerCase();
    const spec = allowMatch[2].trim();
    const tool = getToolFromDb(name);
    if (!tool) return `Tool \`${name}\` not found.`;

    if (/^(all|\*|none|clear)$/i.test(spec)) {
      setToolAllowedTools(name, null);
      if (tool.enabled) {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `All tools re-enabled for \`${name}\`. _Reconfiguring..._` });
        const elapsed = await restartServer();
        return `\`${name}\` now exposes all its tools. OpenCode restarted. _(took ${elapsed.toFixed(1)}s)_`;
      }
      return `\`${name}\` now exposes all its tools (allowlist cleared).`;
    }

    const list = spec.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) return "Provide tool names, e.g. `tool allow slack search,list_channels` (or `all` to reset).";
    setToolAllowedTools(name, list);
    const shown = list.map((t) => `\`${t}\``).join(", ");
    if (tool.enabled) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `Restricting \`${name}\` to ${list.length} tool${list.length === 1 ? "" : "s"}. _Reconfiguring..._` });
      const elapsed = await restartServer();
      return `\`${name}\` now exposes only: ${shown}. OpenCode restarted. _(took ${elapsed.toFixed(1)}s)_`;
    }
    return `\`${name}\` allowlist set to: ${shown}. (Enable the tool to apply.)`;
  }

  // ── tool auth-code <name> <code> [state] ──
  const authCodeMatch = sub.match(/^auth-code\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/i);
  if (authCodeMatch) {
    const name = authCodeMatch[1].toLowerCase();
    const code = authCodeMatch[2];
    const oauthState = authCodeMatch[3];
    await completeOAuthExchange(name, code, oauthState, client, channelId, threadTs);
    return null; // Already posted
  }

  // ── tool remove <name> ──
  const removeMatch = sub.match(/^remove\s+(\S+)$/i);
  if (removeMatch) {
    const name = removeMatch[1].toLowerCase();
    const tool = getToolFromDb(name);
    if (!tool) return `Tool \`${name}\` not found.`;

    const wasActive = tool.auth_type === "oauth"
      ? isOAuthToolActive(name)
      : isToolActive(tool, getToolKey(tool));
    removeTool(name);

    if (wasActive) {
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
    if (tool.auth_type === "oauth") {
      return `Tool \`${name}\` uses OAuth. Use \`tool auth ${name}\` to authorize instead.`;
    }

    setToolKey(name, apiKey);

    if (tool.enabled) {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `API key stored for \`${name}\`. _Reconfiguring... this takes a few seconds._\n:warning: *Delete your message containing the API key for security.*`,
      });
      const elapsed = await restartServer();
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: `Tools updated. OpenCode restarted. _(took ${elapsed.toFixed(1)}s)_`,
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: `Tools updated. OpenCode restarted. _(took ${elapsed.toFixed(1)}s)_\nPick which of \`${name}\`'s tools to expose:` } },
          configureButtonBlock(name),
        ],
      });
      return null;
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

    if (isToolActive({ ...tool, enabled: 1 }, getToolKey(tool))) {
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

    if (isToolActive(tool, getToolKey(tool))) {
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
    "\u2022 `tool auth <name> [--public]` \u2014 start/re-start the OAuth flow; `--public` registers a public/PKCE-only client (no secret)",
    "\u2022 `tool allow <name> <tool1,tool2,\u2026 | all>` \u2014 restrict the server to specific MCP tools (global; `all` re-enables everything)",
    "\u2022 `tool set-client <name> <client-id> [client-secret]` \u2014 set pre-registered OAuth client credentials (omit the secret for a public/PKCE-only client)",
    "\u2022 `tool auth-code <name> <code> <state>` \u2014 complete OAuth with authorization code + state",
    "\u2022 `tool enable <name>` \u2014 enable a disabled tool",
    "\u2022 `tool disable <name>` \u2014 disable a tool",
  ].join("\n");
}
