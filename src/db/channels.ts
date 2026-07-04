import { getDb } from "./index.js";

// --- Channel-to-agent mapping ---

export function getChannelAgent(channelId: string): string | undefined {
  const row = getDb()
    .prepare("SELECT agent FROM channel_agents WHERE channel_id = ?")
    .get(channelId) as { agent: string } | undefined;
  return row?.agent;
}

export function setChannelAgent(channelId: string, channelName: string, agent: string): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO channel_agents (channel_id, channel_name, agent, updated_at) VALUES (?, ?, ?, unixepoch())"
    )
    .run(channelId, channelName, agent);
}

export function clearChannelAgent(channelId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM channel_agents WHERE channel_id = ?")
    .run(channelId);
  return result.changes > 0;
}

export interface ChannelAgentRow {
  channel_id: string;
  channel_name: string;
  agent: string;
}

export function listChannelAgents(): ChannelAgentRow[] {
  return getDb()
    .prepare("SELECT channel_id, channel_name, agent FROM channel_agents ORDER BY channel_name")
    .all() as ChannelAgentRow[];
}

// --- Channel-to-tools mapping ---

export function getChannelTools(channelId: string): string[] | undefined {
  const row = getDb()
    .prepare("SELECT tools FROM channel_tools WHERE channel_id = ?")
    .get(channelId) as { tools: string } | undefined;
  if (!row) return undefined;
  return row.tools.split(",").filter(Boolean);
}

export function setChannelTools(channelId: string, channelName: string, tools: string[]): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO channel_tools (channel_id, channel_name, tools, updated_at) VALUES (?, ?, ?, unixepoch())"
    )
    .run(channelId, channelName, tools.join(","));
}

export function clearChannelTools(channelId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM channel_tools WHERE channel_id = ?")
    .run(channelId);
  return result.changes > 0;
}

export interface ChannelToolsRow {
  channel_id: string;
  channel_name: string;
  tools: string;
}

export function listChannelTools(): ChannelToolsRow[] {
  return getDb()
    .prepare("SELECT channel_id, channel_name, tools FROM channel_tools ORDER BY channel_name")
    .all() as ChannelToolsRow[];
}

/**
 * Resolve the OpenCode agent name based on channel agent and tools.
 * If a custom agent is set, it takes priority (tools are ignored).
 * Otherwise, tools map to predefined agent variants (e.g. build-linear, build-sentry).
 */
export function resolveAgent(channelAgent?: string, channelTools?: string[]): string | undefined {
  if (channelAgent) return channelAgent;
  if (!channelTools || channelTools.length === 0) return undefined;
  const sorted = [...channelTools].sort();
  return `build-${sorted.join("-")}`;
}

/**
 * Agent for an unattended job run: the locked-down job agent, upgraded to the
 * variant carrying the target channel's MCP tools (mirrors resolveAgent naming).
 */
export function resolveJobAgent(channelTools?: string[]): string {
  if (!channelTools || channelTools.length === 0) return "job";
  const sorted = [...channelTools].sort();
  return `job-${sorted.join("-")}`;
}

// ── Channel config ──

export function getChannelConfig(
  channelId: string
): { customPrompt: string; configuredBy: string } | null {
  const row = getDb()
    .prepare("SELECT custom_prompt, configured_by FROM channel_config WHERE channel_id = ?")
    .get(channelId) as { custom_prompt: string; configured_by: string } | undefined;
  if (!row) return null;
  return { customPrompt: row.custom_prompt, configuredBy: row.configured_by };
}

export function setChannelConfig(
  channelId: string,
  customPrompt: string,
  configuredBy: string
): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO channel_config (channel_id, custom_prompt, configured_by, updated_at) VALUES (?, ?, ?, unixepoch())"
    )
    .run(channelId, customPrompt, configuredBy);
}

export function clearChannelConfig(channelId: string): void {
  getDb()
    .prepare("DELETE FROM channel_config WHERE channel_id = ?")
    .run(channelId);
}

export interface ChannelConfigRow {
  channel_id: string;
  custom_prompt: string;
  configured_by: string;
}

export function listChannelConfigs(): ChannelConfigRow[] {
  return getDb()
    .prepare("SELECT channel_id, custom_prompt, configured_by FROM channel_config ORDER BY channel_id")
    .all() as ChannelConfigRow[];
}

// ── Channel-to-repo mapping ──

export function getChannelRepo(channelId: string): string | undefined {
  const row = getDb()
    .prepare("SELECT repo_name FROM channel_repos WHERE channel_id = ?")
    .get(channelId) as { repo_name: string } | undefined;
  return row?.repo_name;
}

export function setChannelRepo(channelId: string, channelName: string, repoName: string): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO channel_repos (channel_id, channel_name, repo_name, updated_at) VALUES (?, ?, ?, unixepoch())"
    )
    .run(channelId, channelName, repoName);
}

export function clearChannelRepo(channelId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM channel_repos WHERE channel_id = ?")
    .run(channelId);
  return result.changes > 0;
}

export interface ChannelRepoRow {
  channel_id: string;
  channel_name: string;
  repo_name: string;
}

export function listChannelRepos(): ChannelRepoRow[] {
  return getDb()
    .prepare("SELECT channel_id, channel_name, repo_name FROM channel_repos ORDER BY channel_name")
    .all() as ChannelRepoRow[];
}
