import { getDb } from "./index.js";

// ── Types ──

export interface SlackUserRow {
  id: string;
  handle: string;
  real_name: string;
  display_name: string;
  title: string;
  email: string;
  tz: string;
  is_bot: number;
  deleted: number;
}

export interface SlackUsergroupRow {
  id: string;
  handle: string;
  name: string;
  description: string;
  member_count: number;
  /** Comma-separated user IDs. */
  members: string;
}

export interface AgentCollaboratorRow {
  user_id: string;
  name: string;
  description: string;
  added_by: string;
}

export type MentionMode = "tag" | "suggest" | "off";
export const MENTION_MODES: readonly MentionMode[] = ["tag", "suggest", "off"];
export const DEFAULT_MENTION_MODE: MentionMode = "suggest";

// ── Directory cache writes (main process) ──

export function replaceSlackUsers(users: SlackUserRow[]): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO slack_users (id, handle, real_name, display_name, title, email, tz, is_bot, deleted, updated_at)
     VALUES (@id, @handle, @real_name, @display_name, @title, @email, @tz, @is_bot, @deleted, unixepoch())`,
  );
  db.transaction(() => {
    db.prepare("DELETE FROM slack_users").run();
    for (const u of users) insert.run(u);
  })();
}

export function replaceSlackUsergroups(groups: SlackUsergroupRow[]): void {
  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO slack_usergroups (id, handle, name, description, member_count, members, updated_at)
     VALUES (@id, @handle, @name, @description, @member_count, @members, unixepoch())`,
  );
  db.transaction(() => {
    db.prepare("DELETE FROM slack_usergroups").run();
    for (const g of groups) insert.run(g);
  })();
}

// ── Directory cache reads ──

export function getSlackUser(id: string): SlackUserRow | undefined {
  return getDb().prepare("SELECT * FROM slack_users WHERE id = ?").get(id) as SlackUserRow | undefined;
}

export function getSlackUsergroup(id: string): SlackUsergroupRow | undefined {
  return getDb().prepare("SELECT * FROM slack_usergroups WHERE id = ?").get(id) as SlackUsergroupRow | undefined;
}

export function findSlackUserByEmail(email: string): SlackUserRow | undefined {
  return getDb()
    .prepare("SELECT * FROM slack_users WHERE email = ? COLLATE NOCASE AND deleted = 0")
    .get(email.trim()) as SlackUserRow | undefined;
}

/** Best label for a user: display name, then real name, then handle. */
export function userLabel(u: Pick<SlackUserRow, "display_name" | "real_name" | "handle" | "id">): string {
  return u.real_name || u.display_name || u.handle || u.id;
}

/**
 * Score how well `fields` match the query tokens. Every token must hit at
 * least one field, otherwise the row is excluded (score 0).
 */
export function scoreMatch(query: string, fields: Array<{ value: string; weight: number }>): number {
  const tokens = query.toLowerCase().split(/[\s,]+/).map((t) => t.replace(/^[@#]/, "")).filter(Boolean);
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const { value, weight } of fields) {
      const v = value.toLowerCase();
      if (!v) continue;
      let s = 0;
      if (v === token) s = 3;
      else if (v.split(/[\s\-_.]+/).some((w) => w.startsWith(token))) s = 2;
      else if (v.includes(token)) s = 1;
      best = Math.max(best, s * weight);
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

export function searchSlackUsers(
  query: string,
  opts: { includeBots?: boolean; limit?: number } = {},
): SlackUserRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM slack_users WHERE deleted = 0 ${opts.includeBots ? "" : "AND is_bot = 0"}`)
    .all() as SlackUserRow[];
  return rows
    .map((u) => ({
      u,
      score: scoreMatch(query, [
        { value: u.handle, weight: 3 },
        { value: u.display_name, weight: 3 },
        { value: u.real_name, weight: 3 },
        { value: u.title, weight: 2 },
        { value: u.email, weight: 1 },
      ]),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 10)
    .map((r) => r.u);
}

export function searchSlackUsergroups(query: string, limit = 10): SlackUsergroupRow[] {
  const rows = getDb().prepare("SELECT * FROM slack_usergroups").all() as SlackUsergroupRow[];
  return rows
    .map((g) => ({
      g,
      score: scoreMatch(query, [
        { value: g.handle, weight: 3 },
        { value: g.name, weight: 3 },
        { value: g.description, weight: 2 },
      ]),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.g);
}

export function countDirectory(): { users: number; groups: number } {
  const db = getDb();
  const users = (db.prepare("SELECT COUNT(*) AS n FROM slack_users WHERE deleted = 0").get() as { n: number }).n;
  const groups = (db.prepare("SELECT COUNT(*) AS n FROM slack_usergroups").get() as { n: number }).n;
  return { users, groups };
}

// ── Agent collaborators ──

export function addAgentCollaborator(userId: string, name: string, description: string, addedBy: string): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO agent_collaborators (user_id, name, description, added_by, created_at)
       VALUES (?, ?, ?, ?, unixepoch())`,
    )
    .run(userId, name, description, addedBy);
}

export function removeAgentCollaborator(userId: string): boolean {
  return getDb().prepare("DELETE FROM agent_collaborators WHERE user_id = ?").run(userId).changes > 0;
}

export function listAgentCollaborators(): AgentCollaboratorRow[] {
  return getDb()
    .prepare("SELECT user_id, name, description, added_by FROM agent_collaborators ORDER BY name")
    .all() as AgentCollaboratorRow[];
}

// ── Per-channel mention mode ──

export function getChannelMentionMode(channelId: string): MentionMode {
  const row = getDb()
    .prepare("SELECT mode FROM channel_mentions WHERE channel_id = ?")
    .get(channelId) as { mode: string } | undefined;
  const mode = row?.mode as MentionMode | undefined;
  return mode && MENTION_MODES.includes(mode) ? mode : DEFAULT_MENTION_MODE;
}

export function setChannelMentionMode(channelId: string, mode: MentionMode): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO channel_mentions (channel_id, mode, updated_at) VALUES (?, ?, unixepoch())")
    .run(channelId, mode);
}

export function clearChannelMentionMode(channelId: string): boolean {
  return getDb().prepare("DELETE FROM channel_mentions WHERE channel_id = ?").run(channelId).changes > 0;
}
