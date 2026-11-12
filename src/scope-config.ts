/**
 * Q&A config for a turn, from its surface (`Surface.kind`) and scope
 * (`Surface.scopeId`). Slack scopes are bare channel IDs, matching the
 * `channel_*` tables.
 */
import { getChannelAgent, getEffectiveTools, resolveAgent, getChannelConfig } from "./sessions.js";
import { surfaceCanSchedule } from "./surfaces/registry.js";
import { resolveRepoForChannel } from "./repo-manager.js";
import type { RepoInfo } from "./context-prefix.js";

export interface ScopeConfig {
  agent?: string;
  tools?: string[];
  repo?: RepoInfo;
  customPrompt?: string;
}

export function resolveScopeConfig(surfaceId: string, scopeId: string): ScopeConfig {
  const tools = getEffectiveTools(surfaceId, scopeId);
  return {
    agent: resolveAgent(getChannelAgent(scopeId), tools, surfaceCanSchedule(surfaceId)),
    tools,
    repo: resolveRepoForChannel(scopeId),
    customPrompt: getChannelConfig(scopeId)?.customPrompt,
  };
}
