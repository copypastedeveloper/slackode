import { mkdirSync, rmSync, existsSync } from "node:fs";
import type { WebClient } from "@slack/web-api";
import { createSession, askQuestion } from "./opencode.js";
import { formatResponse } from "./utils/formatting.js";
import { Action } from "./constants.js";
import {
  type JobRow,
  startRun, finishRun, recordJobOutcome, decrementProbation, getLastSnapshot,
  getRun, getJobById, setJobEnabled,
  type RunStatus,
} from "./db/jobs.js";

const JOB_TIMEOUT_MS = Number(process.env.JOB_TIMEOUT_MS) || 15 * 60 * 1000;
const SCRATCH_BASE = "/tmp/jobs";

export interface RunOutcome {
  status: RunStatus;
  error?: string;
}

/**
 * Execute one job as an unattended agent session on the shared Q&A server,
 * post the result to the job's channel (or the owner's DM during probation),
 * and record the run. Never throws — all failures land in the run record and
 * a DM to the owner.
 */
export async function runJob(job: JobRow, client: WebClient, opts: { manual?: boolean } = {}): Promise<RunOutcome> {
  const runId = startRun(job.id);
  const scratchDir = `${SCRATCH_BASE}/${runId}`;
  console.log(`[jobs] run ${runId} start: ${job.name}${opts.manual ? " (manual)" : ""}`);

  try {
    mkdirSync(scratchDir, { recursive: true });

    // No directory override: sessions against a fresh non-git dir hang opencode
    // (observed on 1.15.13). The session runs from the repo checkout like all
    // others; the prompt directs file output to the scratch dir, which the job
    // agent's external_directory permission covers.
    const sessionId = await createSession(`job: ${job.name}`);
    const prevSnapshot = getLastSnapshot(job.id);

    const question = buildRunPrompt(job, scratchDir, prevSnapshot);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);
    let text: string;
    try {
      const result = await askQuestion({
        sessionId,
        question,
        isNewSession: true,
        agent: "job",
        abortSignal: controller.signal,
        analytics: {
          userId: `job::${job.name}`,
          channelId: job.channel_id,
        },
      });
      text = result.text;
    } finally {
      clearTimeout(timeout);
    }

    const { post, snapshotJson, uploads, noPost } = parseRunOutput(text);

    // Watchers may decide there's nothing worth saying — that's success, not failure.
    if (noPost) {
      if (job.kind !== "watcher") {
        throw new Error("Job declined to post (NO_POST) but is not a watcher.");
      }
      finishRun(runId, "quiet", { snapshotJson });
      recordJobOutcome(job.id, "quiet");
      console.log(`[jobs] run ${runId} quiet: ${job.name}`);
      return { status: "quiet" };
    }
    if (!post.trim()) {
      throw new Error("Job produced no postable output.");
    }

    const probation = job.probation_remaining > 0 && !opts.manual;
    const target = probation ? await openOwnerDm(client, job.created_by) : job.channel_id;
    const threadTs = probation ? undefined : job.thread_ts ?? undefined;

    let parentTs: string | undefined;
    if (probation) {
      const header = await client.chat.postMessage({
        channel: target,
        text:
          `:test_tube: *Probation run for \`${job.name}\`* (${job.probation_remaining} approval${job.probation_remaining === 1 ? "" : "s"} left) — ` +
          `this would have been posted to <#${job.channel_id}>.`,
      });
      parentTs = header.ts;
    }

    parentTs = await postFormatted(client, target, post, probation ? parentTs : threadTs) ?? parentTs;

    const uploadFileIds: string[] = [];
    for (const filePath of uploads) {
      if (!existsSync(filePath)) {
        console.warn(`[jobs] ${job.name}: upload path does not exist, skipping: ${filePath}`);
        continue;
      }
      const filename = filePath.split("/").pop() ?? "upload";
      const res = parentTs
        ? await client.files.uploadV2({ channel_id: target, thread_ts: parentTs, file: filePath, filename })
        : await client.files.uploadV2({ channel_id: target, file: filePath, filename });
      uploadFileIds.push(...extractFileIds(res));
    }

    if (probation) {
      await client.chat.postMessage({
        channel: target,
        text: `Approve this run of \`${job.name}\`?`,
        blocks: [
          {
            type: "actions",
            elements: [
              { type: "button", style: "primary", text: { type: "plain_text", text: `Post to channel` }, action_id: Action.JOB_POST, value: runId },
              { type: "button", text: { type: "plain_text", text: "Needs work" }, action_id: Action.JOB_NEEDS_WORK, value: runId },
              { type: "button", style: "danger", text: { type: "plain_text", text: "Pause job" }, action_id: Action.JOB_PAUSE, value: runId },
            ],
          },
        ],
      });
    }

    finishRun(runId, "ok", { postedTs: parentTs, snapshotJson, postMarkdown: post, uploadFileIds });
    recordJobOutcome(job.id, "ok");
    console.log(`[jobs] run ${runId} ok: ${job.name}`);
    return { status: "ok" };
  } catch (err) {
    const aborted = err instanceof Error && err.message === "Session aborted";
    const status: RunStatus = aborted ? "timeout" : "error";
    const message = aborted
      ? `Timed out after ${Math.round(JOB_TIMEOUT_MS / 60000)} minutes.`
      : err instanceof Error ? err.message : String(err);

    finishRun(runId, status, { error: message });
    recordJobOutcome(job.id, status);
    console.error(`[jobs] run ${runId} ${status}: ${job.name}:`, message);
    await notifyOwnerOfFailure(client, job, message).catch((dmErr) =>
      console.error(`[jobs] failed to DM owner for ${job.name}:`, dmErr),
    );
    return { status, error: message };
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

function buildRunPrompt(job: JobRow, scratchDir: string, prevSnapshot?: string): string {
  const watcher = job.kind === "watcher";
  return [
    `You are running the scheduled ${watcher ? "watcher" : "job"} "${job.name}" unattended. There is no human in this conversation — never ask questions; complete the task with what you have.`,
    `Write any output files to ${scratchDir} (it is the only writable location).`,
    prevSnapshot
      ? `Snapshot from the previous run, for comparison — ${watcher ? "only raise things that are NEW or have meaningfully changed since it" : "mention meaningful changes"}:\n\`\`\`json\n${prevSnapshot}\n\`\`\``
      : "This is the first run; there is no previous snapshot.",
    `Task:\n${job.prompt}`,
    [
      "Structure your final response exactly as:",
      watcher
        ? "1. If (and only if) something warrants attention, the Slack message to post (markdown). If nothing does, the single word NO_POST instead — silence is the expected outcome most runs."
        : "1. The Slack message to post (markdown).",
      `2. ${watcher ? "Always include a" : "Optionally, a"} fenced block tagged \`snapshot\` containing compact JSON summarizing what you observed this run (used for comparison next run${watcher ? ", including on NO_POST runs — it is how you avoid re-raising the same finding" : ""}).`,
      "3. Optionally, a fenced block tagged `uploads` listing absolute paths of files to upload, one per line.",
    ].join("\n"),
  ].join("\n\n");
}

/** Split the agent's response into the postable message, snapshot JSON, and upload paths. */
export function parseRunOutput(text: string): { post: string; snapshotJson?: string; uploads: string[]; noPost: boolean } {
  let post = text;
  let snapshotJson: string | undefined;
  const uploads: string[] = [];

  const snapshotMatch = post.match(/```snapshot\s*\n([\s\S]*?)```/);
  if (snapshotMatch) {
    const raw = snapshotMatch[1].trim();
    try {
      JSON.parse(raw);
      snapshotJson = raw;
    } catch {
      console.warn("[jobs] snapshot block was not valid JSON — discarding");
    }
    post = post.replace(snapshotMatch[0], "");
  }

  const uploadsMatch = post.match(/```uploads\s*\n([\s\S]*?)```/);
  if (uploadsMatch) {
    for (const line of uploadsMatch[1].split("\n")) {
      const p = line.trim();
      if (p.startsWith("/")) uploads.push(p);
    }
    post = post.replace(uploadsMatch[0], "");
  }

  const trimmed = post.trim();
  // Tolerate markdown wrapping (**NO_POST**, `NO_POST`) — stripping those chars
  // also strips the underscore, hence NO_?POST.
  const noPost = /^NO_?POST\.?$/i.test(trimmed.replace(/[*_`]/g, "").trim());
  return { post: trimmed, snapshotJson, uploads, noPost };
}

/** Post markdown via the shared formatter; returns the ts of the first message. */
async function postFormatted(
  client: WebClient, channel: string, markdown: string, threadTs?: string,
): Promise<string | undefined> {
  let firstTs: string | undefined;
  for (const payload of formatResponse(markdown)) {
    const res = await client.chat.postMessage({
      channel,
      thread_ts: threadTs ?? firstTs,
      text: payload.text,
      blocks: payload.blocks,
    });
    firstTs ??= res.ts;
  }
  return firstTs;
}

async function openOwnerDm(client: WebClient, userId: string): Promise<string> {
  const res = await client.conversations.open({ users: userId });
  const id = res.channel?.id;
  if (!id) throw new Error(`Could not open DM with job owner ${userId}`);
  return id;
}

/** Pull file IDs out of a files.uploadV2 response (shape varies by web-api version). */
function extractFileIds(res: unknown): string[] {
  const ids: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if (typeof obj.id === "string" && obj.id.startsWith("F")) ids.push(obj.id);
      if (obj.files) visit(obj.files);
    }
  };
  visit((res as { files?: unknown })?.files);
  return [...new Set(ids)];
}

// ── Probation button actions ──

/** [Post to channel]: forward the stored run content to the job's channel and count the approval. */
export async function approveProbationRun(runId: string, client: WebClient): Promise<string> {
  const run = getRun(runId);
  const job = run && getJobById(run.job_id);
  if (!run || !job) return "That run no longer exists.";
  if (!run.post_markdown) return "This run has no stored content to post (it predates button approvals).";

  const parentTs = await postFormatted(client, job.channel_id, run.post_markdown, job.thread_ts ?? undefined);

  // Re-share uploaded files via their permalinks (the original scratch files are gone).
  const fileIds: string[] = run.upload_file_ids ? JSON.parse(run.upload_file_ids) : [];
  const permalinks: string[] = [];
  for (const id of fileIds) {
    try {
      const info = await client.files.info({ file: id });
      if (info.file?.permalink) permalinks.push(`<${info.file.permalink}|${info.file.name ?? "attachment"}>`);
    } catch (err) {
      console.warn(`[jobs] files.info failed for ${id}:`, err);
    }
  }
  if (permalinks.length > 0) {
    await client.chat.postMessage({
      channel: job.channel_id,
      ...(parentTs ? { thread_ts: parentTs } : {}),
      text: permalinks.join("\n"),
      unfurl_links: true,
      unfurl_media: true,
    });
  }

  decrementProbation(job.id);
  const left = Math.max(job.probation_remaining - 1, 0);
  return left > 0
    ? `:white_check_mark: Posted to <#${job.channel_id}>. ${left} probation approval${left === 1 ? "" : "s"} left for \`${job.name}\`.`
    : `:white_check_mark: Posted to <#${job.channel_id}> — \`${job.name}\` is out of probation and will post there directly from now on.`;
}

/** [Needs work]: no approval counted; the owner should adjust the job prompt. */
export function rejectProbationRun(runId: string): string {
  const run = getRun(runId);
  const job = run && getJobById(run.job_id);
  if (!run || !job) return "That run no longer exists.";
  return `:pencil2: Noted — this run did not count toward probation. Adjust the prompt with \`schedule delete ${job.name}\` + a new \`schedule add\`, and the next run will reflect it.`;
}

/** [Pause job]: stop future runs. */
export function pauseJobFromRun(runId: string): string {
  const run = getRun(runId);
  const job = run && getJobById(run.job_id);
  if (!run || !job) return "That run no longer exists.";
  setJobEnabled(job.id, false);
  return `:double_vertical_bar: Paused \`${job.name}\`. \`schedule resume ${job.name}\` to re-enable it.`;
}

async function notifyOwnerOfFailure(client: WebClient, job: JobRow, message: string): Promise<void> {
  const dm = await openOwnerDm(client, job.created_by);
  await client.chat.postMessage({
    channel: dm,
    text:
      `:warning: Scheduled job \`${job.name}\` failed: ${message}\n` +
      `Use \`schedule run ${job.name}\` to retry or \`schedule pause ${job.name}\` to stop it.`,
  });
}
