/**
 * Knowledge commands for Slack:
 *   knowledge list [--global|--repo|--channel]  → list entries (open to all)
 *   knowledge view <title-or-id>                → show full content (open to all)
 *   knowledge add [--global|--channel|--repo <name>] <title>: <content>  → admin only
 *   knowledge update <title-or-id>: <new content>                        → admin only
 *   knowledge remove <title-or-id>                                       → admin only
 *   knowledge import [--global|--channel|--repo <name>]                  → admin only (with attached .md file)
 */
import {
  addKnowledge,
  getKnowledgeById,
  getKnowledgeByTitle,
  updateKnowledge,
  removeKnowledge,
  listKnowledge,
  getChannelRepo,
  getDefaultRepo,
  type KnowledgeRow,
} from "../sessions.js";

function formatEntry(k: KnowledgeRow): string {
  const scope = k.scope_key ? `${k.scope}:${k.scope_key}` : k.scope;
  const date = new Date(k.updated_at * 1000).toLocaleDateString();
  return `\`#${k.id}\` *${k.title}* (${scope}, ${date})`;
}

function resolveRepoName(channelId: string): string | undefined {
  const channelRepo = getChannelRepo(channelId);
  if (channelRepo) return channelRepo;
  const defaultRepo = getDefaultRepo();
  return defaultRepo?.name;
}

interface ScopeInfo {
  scope: "global" | "repo" | "channel";
  scopeKey: string | null;
  label: string;
}

function parseScope(flags: string | undefined, channelId: string): ScopeInfo {
  if (flags) {
    const trimmed = flags.trim();
    if (/^--global$/i.test(trimmed)) {
      return { scope: "global", scopeKey: null, label: "global" };
    }
    if (/^--channel$/i.test(trimmed)) {
      return { scope: "channel", scopeKey: channelId, label: `channel` };
    }
    const repoMatch = trimmed.match(/^--repo\s+(\S+)$/i);
    if (repoMatch) {
      return { scope: "repo", scopeKey: repoMatch[1], label: `repo:${repoMatch[1]}` };
    }
  }
  // Default: repo from channel mapping, falling back to global
  const repoName = resolveRepoName(channelId);
  if (repoName) {
    return { scope: "repo", scopeKey: repoName, label: `repo:${repoName}` };
  }
  return { scope: "global", scopeKey: null, label: "global" };
}

function findEntry(idOrTitle: string): KnowledgeRow | undefined {
  const idMatch = idOrTitle.match(/^#?(\d+)$/);
  if (idMatch) {
    return getKnowledgeById(Number(idMatch[1]));
  }
  return getKnowledgeByTitle(idOrTitle.trim());
}

export interface KnowledgeImportFile {
  filename: string;
  content: string;
}

export function handleKnowledgeCommand(
  command: string,
  channelId: string,
  userId: string,
  importFiles?: KnowledgeImportFile[],
): string | null {
  // knowledge list [--global|--repo|--channel]
  const listMatch = command.match(/^knowledge\s+list(?:\s+(--\S+(?:\s+\S+)?))?$/i);
  if (listMatch) {
    const scopeFlag = listMatch[1];
    if (scopeFlag) {
      const { scope, scopeKey, label } = parseScope(scopeFlag, channelId);
      const rows = listKnowledge(scope, scopeKey ?? undefined);
      if (rows.length === 0) return `No knowledge entries for *${label}*.`;
      return `*Knowledge (${label}):*\n${rows.map(formatEntry).join("\n")}`;
    }
    // No flag: show all
    const rows = listKnowledge();
    if (rows.length === 0) return "No knowledge entries yet. Use `knowledge add <title>: <content>` to create one.";

    const sections: string[] = [];
    const global = rows.filter((k) => k.scope === "global");
    if (global.length > 0) sections.push("*Global:*\n" + global.map(formatEntry).join("\n"));

    const repos = new Map<string, KnowledgeRow[]>();
    for (const k of rows.filter((k) => k.scope === "repo")) {
      const key = k.scope_key ?? "unknown";
      if (!repos.has(key)) repos.set(key, []);
      repos.get(key)!.push(k);
    }
    for (const [repo, entries] of repos) {
      sections.push(`*Repo (${repo}):*\n` + entries.map(formatEntry).join("\n"));
    }

    const channels = rows.filter((k) => k.scope === "channel");
    if (channels.length > 0) sections.push("*Channel:*\n" + channels.map(formatEntry).join("\n"));

    return sections.join("\n\n");
  }

  // knowledge view <title-or-id>
  const viewMatch = command.match(/^knowledge\s+view\s+(.+)$/i);
  if (viewMatch) {
    const entry = findEntry(viewMatch[1].trim());
    if (!entry) return `Knowledge entry "${viewMatch[1].trim()}" not found.`;
    const scope = entry.scope_key ? `${entry.scope}:${entry.scope_key}` : entry.scope;
    const date = new Date(entry.updated_at * 1000).toLocaleDateString();
    return `*${entry.title}* (\`#${entry.id}\`, ${scope}, updated ${date})\n\n${entry.content}`;
  }

  // knowledge add [--global|--channel|--repo <name>] <title>: <content>
  const addMatch = command.match(/^knowledge\s+add\s+(?:(--\S+(?:\s+\S+)?)\s+)?(.+?):\s*([\s\S]+)$/i);
  if (addMatch) {
    const { scope, scopeKey, label } = parseScope(addMatch[1], channelId);
    const title = addMatch[2].trim();
    const content = addMatch[3].trim();
    if (!title) return "Please provide a title.";
    if (!content) return "Please provide content.";

    // Check for duplicate title in same scope
    const existing = getKnowledgeByTitle(title, scope, scopeKey ?? undefined);
    if (existing) return `A knowledge entry titled "${title}" already exists in ${label} (\`#${existing.id}\`). Use \`knowledge update\` to modify it.`;

    const id = addKnowledge(title, content, scope, scopeKey, userId);
    return `Knowledge \`#${id}\` added to *${label}*: *${title}*`;
  }

  // knowledge update <title-or-id>: <new content>
  const updateMatch = command.match(/^knowledge\s+update\s+(.+?):\s*([\s\S]+)$/i);
  if (updateMatch) {
    const entry = findEntry(updateMatch[1].trim());
    if (!entry) return `Knowledge entry "${updateMatch[1].trim()}" not found.`;
    const content = updateMatch[2].trim();
    if (!content) return "Please provide new content.";
    updateKnowledge(entry.id, content, userId);
    return `Knowledge \`#${entry.id}\` (*${entry.title}*) updated.`;
  }

  // knowledge remove <title-or-id>
  const removeMatch = command.match(/^knowledge\s+remove\s+(.+)$/i);
  if (removeMatch) {
    const entry = findEntry(removeMatch[1].trim());
    if (!entry) return `Knowledge entry "${removeMatch[1].trim()}" not found.`;
    removeKnowledge(entry.id);
    return `Knowledge \`#${entry.id}\` (*${entry.title}*) removed.`;
  }

  // knowledge import [--global|--channel|--repo <name>]
  const importMatch = command.match(/^knowledge\s+import(?:\s+(--\S+(?:\s+\S+)?))?$/i);
  if (importMatch) {
    if (!importFiles || importFiles.length === 0) {
      return "Please attach one or more `.md` files to import.";
    }

    const { scope, scopeKey, label } = parseScope(importMatch[1], channelId);
    const results: string[] = [];

    for (const file of importFiles) {
      // Derive title from filename (strip .md extension)
      const title = file.filename.replace(/\.md$/i, "").replace(/[_-]/g, " ");
      const content = file.content.trim();
      if (!content) {
        results.push(`Skipped empty file: ${file.filename}`);
        continue;
      }

      const existing = getKnowledgeByTitle(title, scope, scopeKey ?? undefined);
      if (existing) {
        updateKnowledge(existing.id, content, userId);
        results.push(`Updated \`#${existing.id}\`: *${title}*`);
      } else {
        const id = addKnowledge(title, content, scope, scopeKey, userId);
        results.push(`Added \`#${id}\`: *${title}*`);
      }
    }

    return `*Imported to ${label}:*\n${results.join("\n")}`;
  }

  return null;
}
