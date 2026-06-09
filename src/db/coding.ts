import { getDb } from "./index.js";

// ── Coding session statuses ──

export const SessionStatus = {
  STARTING: "starting",
  PLANNING: "planning",
  AWAITING_APPROVAL: "awaiting_approval",
  ACTIVE: "active",
} as const;

export type SessionStatusType = (typeof SessionStatus)[keyof typeof SessionStatus];

/** All statuses that represent a "live" session (not destroyed). */
export const LIVE_STATUSES = [
  SessionStatus.STARTING,
  SessionStatus.PLANNING,
  SessionStatus.AWAITING_APPROVAL,
  SessionStatus.ACTIVE,
] as const;

/** Statuses that should be reaped after idle timeout. */
export const REAPABLE_STATUSES = [
  SessionStatus.ACTIVE,
  SessionStatus.PLANNING,
  SessionStatus.AWAITING_APPROVAL,
] as const;

// ── Coding sessions ──

export interface CodingSessionRow {
  thread_key: string;
  user_id: string;
  channel_id: string;
  repo_name: string;
  branch: string;
  worktree_path: string;
  port: number;
  agent: string;
  opencode_session_id: string | null;
  status: string;
  created_at: number;
  last_activity_at: number;
}

export function getCodingSession(threadKey: string): CodingSessionRow | undefined {
  return getDb()
    .prepare("SELECT * FROM coding_sessions WHERE thread_key = ?")
    .get(threadKey) as CodingSessionRow | undefined;
}

export function getAllCodingSessions(): CodingSessionRow[] {
  return getDb()
    .prepare("SELECT * FROM coding_sessions ORDER BY created_at DESC")
    .all() as CodingSessionRow[];
}

export function getActiveCodingSessions(): CodingSessionRow[] {
  return getDb()
    .prepare(`SELECT * FROM coding_sessions WHERE status IN (${LIVE_STATUSES.map((s) => `'${s}'`).join(",")}) ORDER BY created_at DESC`)
    .all() as CodingSessionRow[];
}

export function saveCodingSession(opts: {
  threadKey: string;
  userId: string;
  channelId: string;
  repoName: string;
  branch: string;
  worktreePath: string;
  port: number;
  agent?: string;
}): void {
  getDb()
    .prepare(`
      INSERT INTO coding_sessions (thread_key, user_id, channel_id, repo_name, branch, worktree_path, port, agent, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'starting')
    `)
    .run(opts.threadKey, opts.userId, opts.channelId, opts.repoName, opts.branch, opts.worktreePath, opts.port, opts.agent ?? "code");
}

export function updateCodingSessionAgent(threadKey: string, agent: string): void {
  getDb()
    .prepare("UPDATE coding_sessions SET agent = ?, last_activity_at = unixepoch() WHERE thread_key = ?")
    .run(agent, threadKey);
}

export function updateCodingSessionStatus(threadKey: string, status: string): void {
  getDb()
    .prepare("UPDATE coding_sessions SET status = ?, last_activity_at = unixepoch() WHERE thread_key = ?")
    .run(status, threadKey);
}

export function updateCodingSessionOpencode(threadKey: string, sessionId: string): void {
  getDb()
    .prepare("UPDATE coding_sessions SET opencode_session_id = ?, last_activity_at = unixepoch() WHERE thread_key = ?")
    .run(sessionId, threadKey);
}

export function touchCodingSession(threadKey: string): void {
  getDb()
    .prepare("UPDATE coding_sessions SET last_activity_at = unixepoch() WHERE thread_key = ?")
    .run(threadKey);
}

export function deleteCodingSession(threadKey: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM coding_sessions WHERE thread_key = ?")
    .run(threadKey);
  return result.changes > 0;
}

export function getIdleCodingSessions(maxIdleSeconds: number): CodingSessionRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM coding_sessions WHERE status IN (${REAPABLE_STATUSES.map((s) => `'${s}'`).join(",")}) AND (unixepoch() - last_activity_at) > ?`
    )
    .all(maxIdleSeconds) as CodingSessionRow[];
}
