import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getEnabledTools, getToolKey, getOAuthAccessToken } from "./sessions.js";
import { ensureFreshToken } from "./mcp/oauth-refresh.js";

/** Path to the pristine base config (without MCP injections). */
const BASE_CONFIG_PATH = process.env.BASE_CONFIG_PATH ?? "/app/opencode.json";

export type ConfigMode = "qa" | "code";

/**
 * Reads the pristine base opencode.json, applies the PROVIDER/MODEL,
 * injects MCP server entries and agent variants for all enabled tools
 * (with keys available), and writes the result to the repo dir.
 *
 * @param mode - "qa" (default): read-only build agent. "code": write-enabled code agent.
 *
 * Always starts from the base config so restarts don't accumulate entries.
 */
export async function writeOpencodeConfig(repoDir: string, mode: ConfigMode = "qa"): Promise<void> {
  const config = JSON.parse(readFileSync(BASE_CONFIG_PATH, "utf-8"));

  // Apply provider/model from env (same as the sed in entrypoint.sh)
  const provider = process.env.PROVIDER ?? "github-copilot";
  const model = process.env.MODEL ?? "claude-sonnet-4.6";
  config.model = `${provider}/${model}`;

  // Disable opencode's git snapshot feature. Snapshots track file edits, but this is a
  // read-only Q&A/agent that never edits the repo — so they're pure overhead. Worse, the
  // snapshot git ops race slackode's background repo-sync (git pull) in the same checkout,
  // and intermittently hang the session at "snapshot initialized" (left stale index.lock
  // files in prod). Turning it off removes that whole failure mode.
  config.snapshot = false;

  const tools = getEnabledTools();
  const enabled: string[] = [];

  for (const tool of tools) {
    let key: string | undefined;

    if (tool.auth_type === "oauth") {
      // For OAuth tools, try to get a fresh access token
      key = await ensureFreshToken(tool.name, tool.mcp_url ?? "");
      if (!key) {
        console.log(`[config] ${tool.name} skipped (OAuth not authorized yet).`);
        continue;
      }
    } else {
      key = getToolKey(tool);
      // Remote tools with api_key auth require a key — skip if missing.
      if (tool.mcp_type === "remote" && !key) {
        console.log(`[config] ${tool.name} skipped (no API key set).`);
        continue;
      }
    }

    enabled.push(tool.name);

    // Build MCP server entry
    config.mcp = config.mcp || {};

    if (tool.mcp_type === "remote") {
      const headerPrefix = tool.mcp_header_auth || "Bearer";
      config.mcp[tool.name] = {
        type: "remote",
        url: tool.mcp_url,
        headers: { Authorization: `${headerPrefix} ${key}` },
        enabled: true,
      };
    } else if (tool.mcp_type === "local") {
      const command: string[] = tool.mcp_command
        ? JSON.parse(tool.mcp_command)
        : [];
      const entry: Record<string, unknown> = {
        type: "local",
        command,
        enabled: true,
      };
      if (key && tool.mcp_env_passthrough && tool.env_var) {
        entry.environment = { [tool.env_var]: key };
      }
      config.mcp[tool.name] = entry;
    }

    console.log(`[config] ${tool.name} configured (${tool.mcp_type}, auth: ${tool.auth_type}).`);

    // Disable this tool's MCP tools globally (agents opt in via variants)
    config.tools[`${tool.name}*`] = false;
  }

  // Always register the built-in knowledge MCP server (local stdio, no API key needed).
  config.mcp = config.mcp || {};
  config.mcp.knowledge = {
    type: "local",
    command: ["node", "/app/dist/mcp/knowledge-server.js"],
    enabled: true,
    environment: {
      ...(process.env.SESSIONS_DB_PATH ? { SESSIONS_DB_PATH: process.env.SESSIONS_DB_PATH } : {}),
      ...(process.env.KNOWLEDGE_DIR ? { KNOWLEDGE_DIR: process.env.KNOWLEDGE_DIR } : {}),
      ...(process.env.LANCE_DIR ? { LANCE_DIR: process.env.LANCE_DIR } : {}),
      // Model cache needs a writable dir — must match Dockerfile pre-cache path
      HF_CACHE_DIR: "/home/appuser/.local/share/opencode/huggingface",
    },
  };
  // Enable knowledge tools globally and for each named agent
  config.tools["knowledge*"] = true;
  for (const agentName of Object.keys(config.agent)) {
    if (config.agent[agentName].tools) {
      config.agent[agentName].tools["knowledge*"] = true;
    }
  }
  console.log("[config] Knowledge MCP server configured.");

  if (enabled.length === 0) {
    console.log("[config] No tool API keys configured.");
  } else {
    // Generate agent variants for every non-empty subset of enabled tools.
    // E.g. [linear, sentry] -> build-linear, build-sentry, build-linear-sentry
    const buildAgent = config.agent.build;
    const count = enabled.length;
    for (let mask = 1; mask < (1 << count); mask++) {
      const subset = enabled.filter((_, i) => mask & (1 << i)).sort();
      const agentName = `build-${subset.join("-")}`;
      const toolOverrides: Record<string, boolean> = {};
      for (const t of subset) toolOverrides[`${t}*`] = true;
      config.agent[agentName] = {
        description: `${buildAgent.description} with ${subset.join(", ")} tools`,
        tools: { ...buildAgent.tools, ...toolOverrides },
        permission: {
          ...buildAgent.permission,
          external_directory: {
            "/app/repos/*": "allow",
          },
        },
      };
    }
    console.log(`[config] Generated agent variants for: ${enabled.join(", ")}`);

    // Create a single enrich agent variant with ALL MCP tools enabled.
    // This is used for fast context enrichment before coding sessions.
    const enrichAgent = config.agent.enrich;
    if (enrichAgent) {
      const allToolOverrides: Record<string, boolean> = {};
      for (const t of enabled) allToolOverrides[`${t}*`] = true;
      config.agent.enrich = {
        ...enrichAgent,
        tools: { ...enrichAgent.tools, ...allToolOverrides },
      };
    }
  }

  // In code mode, switch to the write-enabled "code" agent and enable write tools
  if (mode === "code") {
    config.default_agent = "code";
    config.tools.write = true;
    config.tools.edit = true;
    config.tools.patch = true;
    config.permission.edit = { "*": "allow" };
    config.permission.write = { "*": "allow" };
    console.log("[config] Code mode: write tools enabled, default agent = code");
  }

  const outPath = path.join(repoDir, "opencode.json");
  writeFileSync(outPath, JSON.stringify(config, null, 2));
  console.log(`[config] opencode.json written to ${outPath}`);
}
