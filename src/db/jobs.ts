import { randomUUID } from "node:crypto";
import { getDb } from "./index.js";
import { PROBATION_RUNS } from "../constants.js";

export type JobKind = "cron" | "oneshot" | "watcher";
// "quiet" = a watcher ran, found nothing worth posting, and stayed silent.
export type RunStatus = "running" | "ok" | "quiet" | "error" | "timeout" | "skipped";

export interface JobRow {
  id: string;
  name: string;
  kind: JobKind;
  cron: string | null;
  timezone: string;
  run_at: number | null;
  channel_id: string;
  thread_ts: string | null;
  prompt: string;
  repo: string | null;
  path: string | null;
  ref: string | null;
  created_by: string;
  enabled: number;
  probation_remaining: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  /** 1 while a conversationally-created job awaits owner correction by the handler. */
  owner_pending: number;
  created_at: number;
  updated_at: number;
}

export interface JobRunRow {
  id: string;
  job_id: string;
  started_at: number;
  finished_at: number | null;
  status: RunStatus;
  error: string | null;
  posted_ts: string | null;
  snapshot_json: string | null;
  post_markdown: string | null;
  upload_file_ids: string | null;
}

export interface CreateJobOpts {
  name: string;
  kind: JobKind;
  cron?: string;
  timezone?: string;
  runAt?: number;
  channelId: string;
  threadTs?: string;
  prompt: string;
  createdBy: string;
  nextRunAt: number;
  /** Mark the recorded owner as provisional (model-supplied) pending handler correction. */
  ownerPending?: boolean;
}

export function createJob(opts: CreateJobOpts): JobRow {
  const id = randomUUID();
  getDb()
    .prepare(`
      INSERT INTO scheduled_jobs (id, name, kind, cron, timezone, run_at, channel_id, thread_ts, prompt, created_by, next_run_at, probation_remaining, owner_pending)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id, opts.name, opts.kind, opts.cron ?? null,
      opts.timezone ?? "America/Chicago", opts.runAt ?? null,
      opts.channelId, opts.threadTs ?? null, opts.prompt, opts.createdBy, opts.nextRunAt,
      PROBATION_RUNS, opts.ownerPending ? 1 : 0,
    );
  return getJob(opts.name)!;
}

/**
 * Correct a provisionally-owned job to its real owner and clear the pending flag.
 * Used by the handler once the authoritative requesting user is known.
 */
export function reassignJobOwner(id: string, userId: string): void {
  getDb()
    .prepare("UPDATE scheduled_jobs SET created_by = ?, owner_pending = 0, updated_at = unixepoch() WHERE id = ?")
    .run(userId, id);
}

export function getJob(name: string): JobRow | undefined {
  return getDb()
    .prepare("SELECT * FROM scheduled_jobs WHERE name = ?")
    .get(name) as JobRow | undefined;
}

export function getJobById(id: string): JobRow | undefined {
  return getDb()
    .prepare("SELECT * FROM scheduled_jobs WHERE id = ?")
    .get(id) as JobRow | undefined;
}

export function listJobs(): JobRow[] {
  return getDb()
    .prepare("SELECT * FROM scheduled_jobs ORDER BY name")
    .all() as JobRow[];
}

export function countActiveJobsByUser(userId: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM scheduled_jobs WHERE created_by = ? AND enabled = 1")
    .get(userId) as { n: number };
  return row.n;
}

export function getDueJobs(now: number): JobRow[] {
  return getDb()
    .prepare("SELECT * FROM scheduled_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at")
    .all(now) as JobRow[];
}

/**
 * Advance a job past the slot it was claimed for. Oneshots disable themselves;
 * recurring jobs get their next fire time (computed by the caller via croner).
 */
export function advanceJob(id: string, nextRunAt: number | null): void {
  if (nextRunAt === null) {
    getDb()
      .prepare("UPDATE scheduled_jobs SET next_run_at = NULL, enabled = 0, updated_at = unixepoch() WHERE id = ?")
      .run(id);
  } else {
    getDb()
      .prepare("UPDATE scheduled_jobs SET next_run_at = ?, updated_at = unixepoch() WHERE id = ?")
      .run(nextRunAt, id);
  }
}

export interface UpdateJobFields {
  cron?: string;
  timezone?: string;
  runAt?: number | null;
  kind?: JobKind;
  channelId?: string;
  threadTs?: string | null;
  prompt?: string;
  nextRunAt?: number | null;
}

/**
 * Update a job's schedule/prompt/target. Any edit resets probation — changed
 * behavior must re-earn direct posting.
 */
export function updateJob(id: string, fields: UpdateJobFields): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  const map: Array<[keyof UpdateJobFields, string]> = [
    ["cron", "cron"], ["timezone", "timezone"], ["runAt", "run_at"], ["kind", "kind"],
    ["channelId", "channel_id"], ["threadTs", "thread_ts"], ["prompt", "prompt"], ["nextRunAt", "next_run_at"],
  ];
  for (const [key, column] of map) {
    if (fields[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return;
  sets.push(`probation_remaining = ${PROBATION_RUNS}`, "updated_at = unixepoch()");
  getDb()
    .prepare(`UPDATE scheduled_jobs SET ${sets.join(", ")} WHERE id = ?`)
    .run(...values, id);
}

export function setJobEnabled(id: string, enabled: boolean, nextRunAt?: number | null): void {
  getDb()
    .prepare("UPDATE scheduled_jobs SET enabled = ?, next_run_at = COALESCE(?, next_run_at), updated_at = unixepoch() WHERE id = ?")
    .run(enabled ? 1 : 0, nextRunAt ?? null, id);
}

export function deleteJob(id: string): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM job_runs WHERE job_id = ?").run(id);
    db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(id);
  })();
}

export function decrementProbation(id: string): void {
  getDb()
    .prepare("UPDATE scheduled_jobs SET probation_remaining = MAX(probation_remaining - 1, 0), updated_at = unixepoch() WHERE id = ?")
    .run(id);
}

export function recordJobOutcome(id: string, status: RunStatus): void {
  getDb()
    .prepare("UPDATE scheduled_jobs SET last_run_at = unixepoch(), last_status = ?, updated_at = unixepoch() WHERE id = ?")
    .run(status, id);
}

// ── job_runs ──

export function startRun(jobId: string): string {
  const id = randomUUID();
  getDb()
    .prepare("INSERT INTO job_runs (id, job_id) VALUES (?, ?)")
    .run(id, jobId);
  return id;
}

export function finishRun(
  runId: string,
  status: RunStatus,
  opts: { error?: string; postedTs?: string; snapshotJson?: string; postMarkdown?: string; uploadFileIds?: string[] } = {},
): void {
  getDb()
    .prepare("UPDATE job_runs SET finished_at = unixepoch(), status = ?, error = ?, posted_ts = ?, snapshot_json = ?, post_markdown = ?, upload_file_ids = ? WHERE id = ?")
    .run(
      status, opts.error ?? null, opts.postedTs ?? null, opts.snapshotJson ?? null,
      opts.postMarkdown ?? null,
      opts.uploadFileIds && opts.uploadFileIds.length > 0 ? JSON.stringify(opts.uploadFileIds) : null,
      runId,
    );
}

export function getRun(runId: string): JobRunRow | undefined {
  return getDb()
    .prepare("SELECT * FROM job_runs WHERE id = ?")
    .get(runId) as JobRunRow | undefined;
}

/**
 * Mark runs stranded in 'running' (e.g. by a process restart mid-run) as
 * errored. Called once at scheduler startup.
 */
export function markOrphanedRuns(): number {
  const result = getDb()
    .prepare("UPDATE job_runs SET finished_at = unixepoch(), status = 'error', error = 'orphaned by restart' WHERE status = 'running'")
    .run();
  return result.changes;
}

export function getRecentRuns(jobId: string, limit = 5): JobRunRow[] {
  return getDb()
    .prepare("SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(jobId, limit) as JobRunRow[];
}

export interface JobCost {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/**
 * Aggregate token/cost accounting for a job from the turns table (runs are
 * recorded there with user_id = "job::<name>").
 */
export function getJobCost(name: string): JobCost {
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS turns,
             COALESCE(SUM(input_tokens), 0) AS inputTokens,
             COALESCE(SUM(output_tokens), 0) AS outputTokens,
             COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens,
             COALESCE(SUM(cost_usd), 0) AS costUsd
      FROM turns WHERE user_id = ?
    `)
    .get(`job::${name}`) as JobCost;
  return row;
}

/**
 * Most recent completed run's snapshot, for delta narration. Quiet watcher
 * runs count — the agent must remember what it saw even when it didn't post,
 * or it would re-raise the same finding every interval.
 */
export function getLastSnapshot(jobId: string): string | undefined {
  const row = getDb()
    .prepare("SELECT snapshot_json FROM job_runs WHERE job_id = ? AND status IN ('ok', 'quiet') AND snapshot_json IS NOT NULL ORDER BY started_at DESC LIMIT 1")
    .get(jobId) as { snapshot_json: string } | undefined;
  return row?.snapshot_json;
}
