/**
 * Slack Q&A surface: a turn is answered by editing a placeholder message in
 * the thread, with throttled progress edits and a "still working — keep
 * going?" prompt (Stop / Keep going buttons) once the turn runs long.
 */
import type { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";
import type { OpencodeClient } from "@opencode-ai/sdk";
import { Action, TURN_HARD_CAP_MS, TURN_SLOW_CHECK_MS } from "../constants.js";
import { askQuestion, askForShorterResponse } from "../opencode.js";
import { isRestarting, waitForRestart } from "../opencode-server.js";
import { registerRun, getRun, removeRun } from "../run-registry.js";
import {
  getOrCreateSession, deleteSessionMapping, isSessionCompacted, setSessionCompacted,
} from "../sessions.js";
import { listJobs, getJobById, reassignJobOwner } from "../db/jobs.js";
import { runJob } from "../job-runner.js";
import { createProgressUpdater } from "../utils/progress.js";
import { formatResponse } from "../utils/formatting.js";
import { createTurnRunner } from "../turn-runner.js";
import { resolveScopeConfig } from "../scope-config.js";
import type { Surface } from "./types.js";

export const runTurn = createTurnRunner({
  ask: askQuestion,
  isRestarting,
  waitForRestart,
  sessions: {
    getOrCreate: getOrCreateSession,
    remove: deleteSessionMapping,
    isCompacted: isSessionCompacted,
    setCompacted: setSessionCompacted,
  },
  runs: { register: registerRun, get: getRun, remove: removeRun },
  resolveScope: resolveScopeConfig,
  turnCapMs: TURN_HARD_CAP_MS,
});

export interface SlackSurfaceOpts {
  client: WebClient;
  channel: string;
  threadTs: string;
  placeholderTs: string;
  /** The requester; scheduled jobs created during the turn are reassigned to them. */
  userId?: string;
}

export class SlackSurface implements Surface {
  readonly kind = "slack";
  readonly threadKey: string;
  readonly scopeId: string;
  readonly runKey: string;

  private readonly progressUpdater;
  private slowCheckTimer?: ReturnType<typeof setTimeout>;
  private slowCheckTs?: string;
  private jobIdsBefore = new Set<string>();

  constructor(private readonly opts: SlackSurfaceOpts) {
    // Session mappings are keyed by bare thread ts (pre-dates other surfaces).
    this.threadKey = opts.threadTs;
    this.scopeId = opts.channel;
    // The Stop / Keep going buttons carry this value back to src/index.ts.
    this.runKey = `${opts.channel}:${opts.placeholderTs}`;
    this.progressUpdater = createProgressUpdater(opts.client, opts.channel, opts.placeholderTs);
  }

  async restarting(): Promise<void> {
    await this.updatePlaceholder("_I'm reconfiguring right now. Please try again in a few seconds._");
  }

  progress(status: string): void {
    this.progressUpdater.update(status);
  }

  begin(): void {
    // Snapshot existing jobs so we can detect any the agent creates during this
    // session and correct their (model-supplied) owner to the real requester.
    this.jobIdsBefore = new Set(listJobs().map((j) => j.id));
    this.slowCheckTimer = setTimeout(() => { void this.postSlowCheck(); }, TURN_SLOW_CHECK_MS);
  }

  async end(): Promise<void> {
    this.progressUpdater.stop();
    clearTimeout(this.slowCheckTimer);
    if (this.slowCheckTs) {
      await this.opts.client.chat.delete({ channel: this.opts.channel, ts: this.slowCheckTs }).catch(() => {});
    }
  }

  async stopped(): Promise<void> {
    this.progressUpdater.stop();
    await this.updatePlaceholder("_Stopped at your request._");
  }

  async reply(markdown: string, { sessionId, capped }: { sessionId: string; capped: boolean }): Promise<void> {
    const { client, channel, threadTs, placeholderTs, userId } = this.opts;
    const rawMarkdown = capped
      ? `:warning: _I hit my time limit before finishing the research, so this is my best answer from what I gathered — it may be incomplete._\n\n${markdown}`
      : markdown;
    await safePostResponse({ client, channel, threadTs, placeholderTs, rawMarkdown, sessionId });

    // If the agent scheduled a job this session, its owner (created_by) was
    // model-supplied and may be wrong. Correct it to the real requester and fire
    // the deferred review run so the confirmation DM reaches the right person.
    await reconcilePendingJobOwnership(this.jobIdsBefore, userId, threadTs, client);
  }

  private async updatePlaceholder(text: string): Promise<void> {
    await this.opts.client.chat.update({ channel: this.opts.channel, ts: this.opts.placeholderTs, text });
  }

  private async postSlowCheck(): Promise<void> {
    const { client, channel, threadTs } = this.opts;
    const runKey = this.runKey;
    try {
      const posted = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: "Still working on this — it's a big one. Keep going?",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: ":hourglass_flowing_sand: _Still working on this — it's a big one. Keep going?_" } },
          {
            type: "actions",
            elements: [
              { type: "button", text: { type: "plain_text", text: "Keep going" }, style: "primary", action_id: Action.RUN_KEEP_WAITING, value: runKey },
              { type: "button", text: { type: "plain_text", text: "Stop" }, action_id: Action.RUN_STOP, value: runKey },
            ],
          },
        ],
      });
      this.slowCheckTs = posted.ts;
      if (!getRun(runKey)) {
        // Turn finished while we were posting — clean up immediately.
        if (posted.ts) await client.chat.delete({ channel, ts: posted.ts }).catch(() => {});
      }
    } catch (err) {
      console.warn("[run-control] Failed to post slow-check message:", err);
    }
  }
}

/**
 * Jobs created conversationally record a model-supplied owner (see the
 * scheduler MCP) and are flagged owner_pending with their first run deferred.
 * After the session, reassign any such new job to the authoritative requesting
 * user and fire its review run — the review posts only to the owner's DM
 * (probation), so this both fixes ownership and routes the confirmation DM
 * to the person who actually asked.
 *
 * Attribution: a new owner_pending job is claimed by this session when its
 * recorded thread_ts matches this thread (the reliable case — there is exactly
 * one Thread ID in context, so the model can't confuse it the way it confuses
 * user IDs). Jobs stamped with a *different* thread belong to a concurrent
 * session and are left alone. A job with no thread falls back to the
 * "created during this session's window" heuristic.
 */
async function reconcilePendingJobOwnership(
  before: Set<string>,
  userId: string | undefined,
  threadTs: string,
  client: WebClient,
): Promise<void> {
  if (!userId) return;
  let pending;
  try {
    pending = listJobs().filter((j) => {
      if (!j.owner_pending) return false;
      // Thread-tagged jobs: claim only our own thread's, ignore other threads'.
      if (j.thread_ts) return j.thread_ts === threadTs;
      // Untagged (model omitted Thread ID): fall back to the session window.
      return !before.has(j.id);
    });
  } catch (err) {
    console.error("[jobs] ownership reconcile: listJobs failed:", err);
    return;
  }
  for (const job of pending) {
    try {
      if (job.created_by !== userId) {
        console.log(`[jobs] correcting owner of ${job.name}: ${job.created_by} -> ${userId}`);
      }
      reassignJobOwner(job.id, userId);
      const fresh = getJobById(job.id);
      if (fresh) {
        // Fire-and-forget: the review run spawns its own session and DMs the owner.
        runJob(fresh, client).catch((err) =>
          console.error(`[jobs] deferred review run for ${fresh.name} failed:`, err),
        );
      }
    } catch (err) {
      console.error(`[jobs] ownership reconcile failed for ${job.name}:`, err);
    }
  }
}

// ── Safe Slack posting (catches msg_too_long and falls back) ──

export interface SafePostOpts {
  client: WebClient;
  channel: string;
  threadTs: string;
  placeholderTs: string;
  rawMarkdown: string;
  /** Session ID to retry with the same agent if msg_too_long. */
  sessionId?: string;
  /** Custom OpenCode client (for coding sessions). */
  customClient?: OpencodeClient;
  /** Custom base URL (for coding sessions). */
  customBaseUrl?: string;
  /** Append action buttons to the last message. */
  actionButtons?: KnownBlock;
}

export async function safePostResponse(opts: SafePostOpts): Promise<void> {
  const { client, channel, threadTs, placeholderTs, rawMarkdown, sessionId, customClient, customBaseUrl, actionButtons } = opts;

  const tryPost = async (markdown: string) => {
    const messages = formatResponse(markdown);
    if (actionButtons) {
      const last = messages[messages.length - 1];
      if (last.blocks.length >= 50) {
        // Last message is full — append buttons as a separate message
        messages.push({ text: "", blocks: [actionButtons] });
      } else {
        last.blocks.push(actionButtons);
      }
    }
    const first = messages[0];
    await client.chat.update({
      channel,
      ts: placeholderTs,
      text: first.text,
      ...(first.blocks && { blocks: first.blocks }),
    });
    for (let i = 1; i < messages.length; i++) {
      const msg = messages[i];
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: msg.text,
        ...(msg.blocks && { blocks: msg.blocks }),
      });
    }
  };

  try {
    await tryPost(rawMarkdown);
  } catch (err) {
    const isSlackError = err instanceof Error && err.message.includes("msg_too_long");
    if (!isSlackError) throw err;

    console.warn("[slack] msg_too_long — asking agent to shorten");
    await client.chat.update({
      channel,
      ts: placeholderTs,
      text: "_Response was too long — asking for a shorter version..._",
    });

    if (sessionId) {
      const shorter = await askForShorterResponse({ sessionId, customClient, customBaseUrl });
      await tryPost(shorter);
    } else {
      // No session to retry with — hard fallback
      await client.chat.update({
        channel,
        ts: placeholderTs,
        text: "(Response too long for Slack. Please try asking a more specific question.)",
      });
    }
  }
}
