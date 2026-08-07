import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getToolKey, type ToolRow } from "../sessions.js";
import { ensureFreshToken } from "./oauth-refresh.js";

const CONNECT_TIMEOUT_MS = 12_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)),
  ]);
}

/**
 * Connect to an MCP server and return the names of the tools it exposes
 * (the bare tool names, e.g. "search_knowledge" — NOT the opencode-prefixed
 * "servername_search_knowledge"). Used to populate the tool-allowlist UI.
 *
 * Throws with a human-readable message on any failure so the caller can show
 * an error + retry.
 */
export async function listMcpTools(tool: ToolRow): Promise<string[]> {
  if (tool.mcp_type === "local") {
    const transport = localTransport(tool);
    return connectAndList(() => transport);
  }

  const { url, headers } = await remoteConnDetails(tool);
  // Prefer Streamable HTTP; fall back to SSE for older servers.
  try {
    return await connectAndList(() => new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
  } catch (err) {
    try {
      return await connectAndList(() => new SSEClientTransport(url, { requestInit: { headers } }));
    } catch {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
}

async function connectAndList(makeTransport: () => Parameters<Client["connect"]>[0]): Promise<string[]> {
  const client = new Client({ name: "slackode-config", version: "1.0.0" }, { capabilities: {} });
  try {
    await withTimeout(client.connect(makeTransport()), CONNECT_TIMEOUT_MS, "MCP connect");
    const res = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, "listTools");
    return res.tools.map((t) => t.name).sort();
  } finally {
    await client.close().catch(() => {});
  }
}

async function remoteConnDetails(tool: ToolRow): Promise<{ url: URL; headers: Record<string, string> }> {
  if (!tool.mcp_url) throw new Error("Tool has no MCP URL configured.");

  const key = tool.auth_type === "oauth"
    ? await ensureFreshToken(tool.name, tool.mcp_url)
    : getToolKey(tool);
  if (tool.auth_type === "oauth" && !key) throw new Error("OAuth not authorized yet — run `tool auth` first.");
  if (tool.auth_type !== "oauth" && tool.mcp_type === "remote" && !key) throw new Error("No API key set — run `tool set-key` first.");

  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `${tool.mcp_header_auth || "Bearer"} ${key}`;
  return { url: new URL(tool.mcp_url), headers };
}

function localTransport(tool: ToolRow): StdioClientTransport {
  const command: string[] = tool.mcp_command ? JSON.parse(tool.mcp_command) : [];
  if (command.length === 0) throw new Error("Tool has no MCP command configured.");
  const key = getToolKey(tool);
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (key && tool.mcp_env_passthrough && tool.env_var) env[tool.env_var] = key;
  return new StdioClientTransport({ command: command[0], args: command.slice(1), env });
}
