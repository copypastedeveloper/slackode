import type { WebClient } from "@slack/web-api";
import { existsSync, rmSync } from "node:fs";
import {
  getRepo, getAllRepos, getDefaultRepo, removeRepo as dbRemoveRepo,
  setDefaultRepo as dbSetDefaultRepo, setRepoAllowSkills,
} from "../sessions.js";
import { addRepo, pullAllRepos, nameFromUrl } from "../repo-manager.js";
import { writeSkillManifest } from "../skill-manifest.js";

/**
 * Handle `repo <subcommand>` commands from Slack.
 * Returns a reply string, or null if not a repo command.
 */
export async function handleRepoCommand(
  command: string,
  channelId: string,
  userId: string,
  threadTs: string,
  client: WebClient,
): Promise<string | null> {
  const match = command.match(/^repo\s+(.+)$/i);
  if (!match) return null;

  const sub = match[1].trim();

  // ── repo list ──
  if (/^list$/i.test(sub)) {
    const repos = getAllRepos();
    if (repos.length === 0) {
      return "No repos registered. Use `repo add <name> <url>` to add one.";
    }
    const lines = repos.map((r) => {
      const badges = [
        r.is_default ? "default" : "",
        r.enabled ? "enabled" : "disabled",
        r.allow_skills ? "skills:on" : "skills:off",
      ].filter(Boolean).join(", ");
      return `\u2022 \`${r.name}\` \u2014 ${r.url} [${badges}]`;
    });
    return `*Registered repos:*\n${lines.join("\n")}`;
  }

  // ── repo add <name> <url>  OR  repo add <url> ──
  const addMatch = sub.match(/^add\s+(\S+)(?:\s+(\S+))?$/i);
  if (addMatch) {
    let name: string;
    let url: string;

    if (addMatch[2]) {
      // repo add <name> <url>
      name = addMatch[1];
      url = addMatch[2].replace(/^<|>$/g, ""); // strip Slack auto-link brackets
    } else {
      // repo add <url> — derive name from URL
      url = addMatch[1].replace(/^<|>$/g, "");
      name = nameFromUrl(url);
    }

    if (getRepo(name)) {
      return `Repo \`${name}\` already exists. Use \`repo remove ${name}\` first to re-register.`;
    }

    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `Cloning \`${name}\` from ${url}... this may take a moment.`,
    });

    try {
      await addRepo(name, url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Failed to add repo \`${name}\`: ${msg}`;
    }

    return `Repo \`${name}\` registered and cloned. Use \`config set repo ${name}\` in a channel to start using it.`;
  }

  // ── repo remove <name> ──
  const removeMatch = sub.match(/^remove\s+(\S+)$/i);
  if (removeMatch) {
    const name = removeMatch[1];
    const repo = getRepo(name);
    if (!repo) return `Repo \`${name}\` not found.`;
    if (repo.is_default) {
      return `Cannot remove the default repo. Set a different default first with \`repo set-default <name>\`.`;
    }
    const repoDir = repo.dir;
    dbRemoveRepo(name);
    // Clean up the cloned directory on disk
    if (existsSync(repoDir)) {
      try {
        rmSync(repoDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[repo-commands] Failed to remove directory ${repoDir}:`, err);
      }
    }
    return `Repo \`${name}\` removed. Channels that were using it will fall back to the default repo.`;
  }

  // ── repo set-default <name> ──
  const defaultMatch = sub.match(/^set-default\s+(\S+)$/i);
  if (defaultMatch) {
    const name = defaultMatch[1];
    const repo = getRepo(name);
    if (!repo) return `Repo \`${name}\` not found.`;
    dbSetDefaultRepo(name);
    return `Default repo set to \`${name}\`.`;
  }

  // ── repo allow-skills <name> on|off ──
  const skillsMatch = sub.match(/^allow-skills\s+(\S+)\s+(on|off)$/i);
  if (skillsMatch) {
    const name = skillsMatch[1];
    const allow = skillsMatch[2].toLowerCase() === "on";
    const repo = getRepo(name);
    if (!repo) return `Repo \`${name}\` not found.`;
    setRepoAllowSkills(name, allow);
    try {
      writeSkillManifest(repo.dir, { allowSkills: allow });
    } catch (err) {
      console.warn(`[repo-commands] Skill manifest refresh failed for ${name}:`, err);
    }
    return `Skills for \`${name}\` are now \`${allow ? "on" : "off"}\`. Active sessions will pick this up after their next restart.`;
  }

  // ── repo sync ──
  if (/^sync$/i.test(sub)) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "_Pulling latest for all repos..._",
    });
    pullAllRepos();
    return "All repos synced.";
  }

  return [
    "Unrecognized repo command. Available commands:",
    "\u2022 `repo list` \u2014 show all registered repos",
    "\u2022 `repo add <name> <url>` \u2014 clone and register a new repo",
    "\u2022 `repo remove <name>` \u2014 unregister a repo",
    "\u2022 `repo set-default <name>` \u2014 set the default repo",
    "\u2022 `repo allow-skills <name> on|off` \u2014 toggle whether the repo's `.claude/skills/` and `.opencode/skill[s]/` are surfaced to the agent",
    "\u2022 `repo sync` \u2014 pull latest for all repos",
  ].join("\n");
}
