/**
 * Memory commands for Slack:
 *   remember: <content>           → save to repo scope
 *   remember --global: <content>  → save to global scope
 *   remember --channel: <content> → save to channel scope
 *   recall: <query>               → search memories
 *   forget: <id>                  → delete by ID (only if you created it)
 *   memories                      → list for current scope
 */
import {
  addMemory,
  searchMemories,
  deleteMemory,
  listMemories,
  getChannelRepo,
  getDefaultRepo,
  type MemoryRow,
} from "../sessions.js";

function formatMemory(m: MemoryRow): string {
  const scope = m.scope_key ? `${m.scope}:${m.scope_key}` : m.scope;
  const tags = m.tags ? ` [${m.tags}]` : "";
  const date = new Date(m.created_at * 1000).toLocaleDateString();
  return `\`#${m.id}\` (${scope}${tags}, ${date}) ${m.content}`;
}

function resolveRepoName(channelId: string): string | undefined {
  const channelRepo = getChannelRepo(channelId);
  if (channelRepo) return channelRepo;
  const defaultRepo = getDefaultRepo();
  return defaultRepo?.name;
}

export function handleMemoryCommand(
  command: string,
  channelId: string,
  userId: string,
): string | null {
  // remember --global: <content>
  const rememberGlobal = command.match(/^remember\s+--global[:\s]\s*(.+)$/is);
  if (rememberGlobal) {
    const content = rememberGlobal[1].trim();
    if (!content) return "Please provide content to remember.";
    const id = addMemory(content, "global", null, null, userId);
    return `Saved global memory \`#${id}\`: ${content}`;
  }

  // remember --channel: <content>
  const rememberChannel = command.match(/^remember\s+--channel[:\s]\s*(.+)$/is);
  if (rememberChannel) {
    const content = rememberChannel[1].trim();
    if (!content) return "Please provide content to remember.";
    const id = addMemory(content, "channel", channelId, null, userId);
    return `Saved channel memory \`#${id}\`: ${content}`;
  }

  // remember: <content> (default: repo scope)
  const remember = command.match(/^remember[:\s]\s*(.+)$/is);
  if (remember) {
    const content = remember[1].trim();
    if (!content) return "Please provide content to remember.";
    const repoName = resolveRepoName(channelId);
    const id = addMemory(content, repoName ? "repo" : "global", repoName ?? null, null, userId);
    const scope = repoName ? `repo:${repoName}` : "global";
    return `Saved ${scope} memory \`#${id}\`: ${content}`;
  }

  // recall: <query>
  const recall = command.match(/^recall[:\s]\s*(.+)$/is);
  if (recall) {
    const query = recall[1].trim();
    if (!query) return "Please provide a search query.";
    const results = searchMemories(query);
    if (results.length === 0) return `No memories found matching "${query}".`;
    const lines = results.map(formatMemory);
    return `*Memories matching "${query}":*\n${lines.join("\n")}`;
  }

  // forget: <id>
  const forget = command.match(/^forget[:\s]\s*#?(\d+)$/i);
  if (forget) {
    const id = Number(forget[1]);
    const removed = deleteMemory(id, userId);
    if (removed) return `Memory \`#${id}\` deleted.`;
    return `Memory \`#${id}\` not found or you didn't create it.`;
  }

  // memories
  if (/^memories$/i.test(command.trim())) {
    const repoName = resolveRepoName(channelId);
    const all = listMemories();
    if (all.length === 0) return "No memories saved yet. Use `remember: <content>` to save one.";

    const sections: string[] = [];

    const global = all.filter((m) => m.scope === "global");
    if (global.length > 0) {
      sections.push("*Global:*\n" + global.map(formatMemory).join("\n"));
    }

    if (repoName) {
      const repo = all.filter((m) => m.scope === "repo" && m.scope_key === repoName);
      if (repo.length > 0) {
        sections.push(`*Repo (${repoName}):*\n` + repo.map(formatMemory).join("\n"));
      }
    }

    const channel = all.filter((m) => m.scope === "channel" && m.scope_key === channelId);
    if (channel.length > 0) {
      sections.push("*Channel:*\n" + channel.map(formatMemory).join("\n"));
    }

    if (sections.length === 0) return "No memories for this context. Use `remember: <content>` to save one.";
    return sections.join("\n\n");
  }

  return null;
}
