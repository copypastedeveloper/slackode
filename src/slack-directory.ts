/**
 * Slack directory sync: caches workspace people and user groups in SQLite so
 * the agent (via the directory MCP server) can find who to tag, and so the
 * mention policy can resolve IDs to names without per-message API calls.
 *
 * users.list and usergroups.list are Tier 2 rate-limited, so we refresh on
 * startup and then hourly rather than on demand.
 */
import type { WebClient } from "@slack/web-api";
import {
  replaceSlackUsers, replaceSlackUsergroups, getSlackUser, getSlackUsergroup, userLabel,
  type SlackUserRow, type SlackUsergroupRow,
} from "./db/directory.js";
import { getChannelMentionMode } from "./db/directory.js";
import { applyMentionPolicy, type DirectoryLookup, type MentionResult } from "./mentions.js";

/** Mention-policy lookup backed by the cached directory. */
export const directoryLookup: DirectoryLookup = {
  user(id) {
    const u = getSlackUser(id);
    return u && !u.deleted ? { label: userLabel(u), isBot: !!u.is_bot } : undefined;
  },
  group(id) {
    const g = getSlackUsergroup(id);
    return g ? { handle: g.handle } : undefined;
  },
};

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

let timer: ReturnType<typeof setInterval> | null = null;

function slackErrorCode(err: unknown): string | undefined {
  return (err as { data?: { error?: string } })?.data?.error;
}

async function syncUsers(client: WebClient): Promise<number> {
  const rows: SlackUserRow[] = [];
  let cursor: string | undefined;
  do {
    const res = await client.users.list({ limit: 200, cursor });
    for (const m of res.members ?? []) {
      if (!m.id) continue;
      rows.push({
        id: m.id,
        handle: m.name ?? "",
        real_name: m.profile?.real_name ?? m.real_name ?? "",
        display_name: m.profile?.display_name ?? "",
        title: m.profile?.title ?? "",
        // Requires users:read.email; empty otherwise.
        email: m.profile?.email ?? "",
        tz: m.tz ?? "",
        is_bot: m.is_bot || m.id === "USLACKBOT" ? 1 : 0,
        deleted: m.deleted ? 1 : 0,
      });
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  replaceSlackUsers(rows);
  return rows.length;
}

async function syncUsergroups(client: WebClient): Promise<number> {
  const res = await client.usergroups.list({ include_users: true, include_disabled: false });
  const rows: SlackUsergroupRow[] = (res.usergroups ?? [])
    .filter((g) => g.id && g.handle)
    .map((g) => ({
      id: g.id!,
      handle: g.handle!,
      name: g.name ?? "",
      description: g.description ?? "",
      member_count: g.user_count ?? g.users?.length ?? 0,
      members: (g.users ?? []).join(","),
    }));
  replaceSlackUsergroups(rows);
  return rows.length;
}

export async function refreshSlackDirectory(client: WebClient): Promise<void> {
  try {
    const n = await syncUsers(client);
    console.log(`[directory] Cached ${n} Slack users.`);
  } catch (err) {
    console.warn(`[directory] users.list failed (${slackErrorCode(err) ?? err}).`);
  }
  try {
    const n = await syncUsergroups(client);
    console.log(`[directory] Cached ${n} Slack user groups.`);
  } catch (err) {
    const code = slackErrorCode(err);
    if (code === "missing_scope") {
      console.warn("[directory] usergroups.list needs the usergroups:read scope — group lookup disabled.");
    } else if (code === "paid_teams_only") {
      console.warn("[directory] User groups are not available on this Slack plan.");
    } else {
      console.warn(`[directory] usergroups.list failed (${code ?? err}).`);
    }
  }
}

export function startDirectorySync(client: WebClient): void {
  if (timer) return;
  void refreshSlackDirectory(client);
  timer = setInterval(() => void refreshSlackDirectory(client), REFRESH_INTERVAL_MS);
  timer.unref?.();
}

export function stopDirectorySync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export interface MentionContext {
  /** Channel whose mention mode applies. */
  channelId: string;
  /** User IDs already in the conversation (may be pinged in suggest mode). */
  participants?: Iterable<string>;
  botUserId?: string;
  triggeredByBot?: boolean;
  /** Force a mode (e.g. "off" for transient progress updates). */
  mode?: "tag" | "suggest" | "off";
}

/** Apply the channel's mention policy to agent-written markdown. */
export function applyChannelMentionPolicy(markdown: string, mc: MentionContext): MentionResult {
  return applyMentionPolicy(markdown, {
    mode: mc.mode ?? getChannelMentionMode(mc.channelId),
    participants: new Set(mc.participants ?? []),
    botUserId: mc.botUserId,
    triggeredByBot: mc.triggeredByBot,
  }, directoryLookup);
}
