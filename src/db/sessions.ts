import { getDb } from "./index.js";
import { createSession } from "../opencode.js";

export function getSessionId(threadKey: string): string | undefined {
  const row = getDb()
    .prepare("SELECT session_id FROM sessions WHERE thread_key = ?")
    .get(threadKey) as { session_id: string } | undefined;
  return row?.session_id;
}

export function saveSession(threadKey: string, sessionId: string, channelId?: string): void {
  getDb()
    .prepare(
      "INSERT OR REPLACE INTO sessions (thread_key, session_id, channel_id) VALUES (?, ?, ?)"
    )
    .run(threadKey, sessionId, channelId ?? null);
}

export function isSessionCompacted(threadKey: string): boolean {
  const row = getDb()
    .prepare("SELECT compacted FROM sessions WHERE thread_key = ?")
    .get(threadKey) as { compacted: number } | undefined;
  return row?.compacted === 1;
}

export function setSessionCompacted(threadKey: string, compacted: boolean): void {
  getDb()
    .prepare("UPDATE sessions SET compacted = ? WHERE thread_key = ?")
    .run(compacted ? 1 : 0, threadKey);
}

/**
 * Drop the thread→session mapping so the next question in the thread gets a
 * fresh OpenCode session. Used when a session is wedged (accepts prompts but
 * never starts a turn) — the mapping is the only recovery lever we have.
 */
export function deleteSessionMapping(threadKey: string): void {
  getDb().prepare("DELETE FROM sessions WHERE thread_key = ?").run(threadKey);
}

/**
 * Get an existing session or create a new one.
 * Returns isNew so the caller can include full context in the first message.
 */
export async function getOrCreateSession(
  threadKey: string,
  channelId?: string,
): Promise<{ sessionId: string; isNew: boolean }> {
  const existing = getSessionId(threadKey);
  if (existing) {
    return { sessionId: existing, isNew: false };
  }

  const sessionId = await createSession(`Slack thread: ${threadKey}`);
  saveSession(threadKey, sessionId, channelId);

  return { sessionId, isNew: true };
}
