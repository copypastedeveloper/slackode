import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getEnabledTools, getToolKey } from "./sessions.js";

/** Path to the pristine base config (without MCP injections). */
const BASE_CONFIG_PATH = process.env.BASE_CONFIG_PATH ?? "/app/opencode.json";

/**
 * Reads the pristine base opencode.json, applies the PROVIDER/MODEL,
 * injects MCP server entries and agent variants for all enabled tools
 * (with keys available), and writes the result to the repo dir.
 *
 * Always starts from the base config so restarts don't accumulate entries.
 */
export function writeOpencodeConfig(repoDir: string): void {
  const config = JSON.parse(readFileSync(BASE_CONFIG_PATH, "utf-8"));

  // Apply provider/model from env (same as the sed in entrypoint.sh)
  const provider = process.env.PROVIDER ?? "github-copilot";
  const model = process.env.MODEL ?? "claude-sonnet-4.6";
  config.model = `${provider}/${model}`;

  const tools = getEnabledTools();
  const enabled: string[] = [];

  for (const tool of tools) {
    const key = getToolKey(tool);
    if (!key) {
      console.log(`[config] ${tool.name} skipped (no API key set).`);
      continue;
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
      if (tool.mcp_env_passthrough && tool.env_var) {
        entry.environment = { [tool.env_var]: key };
      }
      config.mcp[tool.name] = entry;
    }

    console.log(`[config] ${tool.name} configured (${tool.mcp_type}).`);

    // Disable this tool's MCP tools globally (agents opt in via variants)
    config.tools[`${tool.name}*`] = false;
  }

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
        permission: { ...buildAgent.permission },
      };
    }
    console.log(`[config] Generated agent variants for: ${enabled.join(", ")}`);
  }

  const outPath = path.join(repoDir, "opencode.json");
  writeFileSync(outPath, JSON.stringify(config, null, 2));
  console.log(`[config] opencode.json written to ${outPath}`);
}
