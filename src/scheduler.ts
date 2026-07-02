import { Cron } from "croner";
import type { WebClient } from "@slack/web-api";
import { getDueJobs, advanceJob, recordJobOutcome, markOrphanedRuns, type JobRow } from "./db/jobs.js";
import { runJob } from "./job-runner.js";

const TICK_MS = 30_000;
// A cron slot missed by more than this (bot was down) is skipped, not replayed.
const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

let tickInterval: ReturnType<typeof setInterval> | undefined;
let running = false;

/** Compute the next fire time (unixepoch seconds) for a cron job, or null when it never fires again. */
export function nextCronRun(expression: string, timezone: string, from?: Date): number | null {
  const next = new Cron(expression, { timezone }).nextRun(from ?? new Date());
  return next ? Math.floor(next.getTime() / 1000) : null;
}

/** Validate a cron expression + timezone pair; returns an error message or undefined. */
export function validateCron(expression: string, timezone: string): string | undefined {
  try {
    const next = new Cron(expression, { timezone }).nextRun();
    if (!next) return "That cron expression never fires.";
    return undefined;
  } catch (err) {
    return `Invalid cron expression or timezone: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function tick(client: WebClient): Promise<void> {
  if (running) return; // previous tick's runs still in flight
  running = true;
  try {
    const nowMs = Date.now();
    const due = getDueJobs(Math.floor(nowMs / 1000));

    for (const job of due) {
      // Claim the slot before running so a crash mid-run can't refire in a loop.
      advanceJob(job.id, job.kind === "oneshot" ? null : nextCronRun(job.cron!, job.timezone));

      const missedByMs = nowMs - (job.next_run_at ?? 0) * 1000;
      if (missedByMs > CATCH_UP_WINDOW_MS) {
        recordJobOutcome(job.id, "skipped");
        console.warn(`[scheduler] ${job.name}: slot missed by ${Math.round(missedByMs / 3600000)}h — skipping`);
        await notifySkipped(client, job, missedByMs).catch((err) =>
          console.error(`[scheduler] skip-DM failed for ${job.name}:`, err),
        );
        continue;
      }

      // Sequential on purpose: one unattended session at a time on the shared server.
      await runJob(job, client);
    }
  } catch (err) {
    console.error("[scheduler] tick failed:", err);
  } finally {
    running = false;
  }
}

export function startScheduler(client: WebClient): void {
  if (tickInterval) return;
  const orphaned = markOrphanedRuns();
  if (orphaned > 0) console.warn(`[scheduler] marked ${orphaned} orphaned run(s) from a prior shutdown as errored`);
  tickInterval = setInterval(() => {
    tick(client).catch((err) => console.error("[scheduler] tick error:", err));
  }, TICK_MS);
  console.log(`[scheduler] started (tick every ${TICK_MS / 1000}s)`);
}

export function stopScheduler(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = undefined;
  }
}

async function notifySkipped(client: WebClient, job: JobRow, missedByMs: number): Promise<void> {
  const dm = await client.conversations.open({ users: job.created_by });
  if (!dm.channel?.id) return;
  await client.chat.postMessage({
    channel: dm.channel.id,
    text:
      `:fast_forward: Scheduled job \`${job.name}\` missed its slot by ~${Math.round(missedByMs / 3600000)}h ` +
      `(the bot was likely down) and was skipped. It will run at its next scheduled time.`,
  });
}
