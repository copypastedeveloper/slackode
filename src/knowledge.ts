/**
 * DB-backed knowledge retrieval.
 *
 * Knowledge entries are stored in the `knowledge` table in SQLite,
 * managed via Slack commands. This module provides read-only accessors
 * used by the context prefix builder.
 */
import { getKnowledgeContent } from "./sessions.js";

const MAX_GLOBAL_CHARS = 2000;
const MAX_REPO_CHARS = 1500;
const MAX_CHANNEL_CHARS = 1000;

/** Read all global knowledge entries. */
export function getGlobalKnowledge(): string {
  return getKnowledgeContent("global", undefined, MAX_GLOBAL_CHARS);
}

/** Read repo-specific knowledge entries. */
export function getRepoKnowledge(repoName: string): string {
  return getKnowledgeContent("repo", repoName, MAX_REPO_CHARS);
}

/** Read channel-specific knowledge entries. */
export function getChannelKnowledge(channelName: string): string {
  return getKnowledgeContent("channel", channelName, MAX_CHANNEL_CHARS);
}
