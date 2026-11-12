/**
 * Q&A config by `Surface.scopeId`. Slack scopes are bare channel IDs, matching
 * the `channel_*` tables; other surfaces store namespaced IDs (e.g.
 * `linear:<team>`) in the same tables.
 */
import { getChannelAgent, getChannelTools, resolveAgent, getChannelConfig } from "./sessions.js";
import { resolveRepoForChannel } from "./repo-manager.js";
import type { RepoInfo } from "./context-prefix.js";

export interface ScopeConfig {
  agent?: string;
  tools?: string[];
  repo?: RepoInfo;
  customPrompt?: string;
}

export function resolveScopeConfig(scopeId: string): ScopeConfig {
  const tools = getChannelTools(scopeId);
  return {
    agent: resolveAgent(getChannelAgent(scopeId), tools),
    tools,
    repo: resolveRepoForChannel(scopeId),
    customPrompt: getChannelConfig(scopeId)?.customPrompt,
  };
}
