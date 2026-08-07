#!/usr/bin/env node
/**
 * Scheduler MCP server — lets the conversational agent create and edit
 * scheduled jobs on the user's behalf ("schedule this as a weekly job",
 * "make that run Fridays instead").
 *
 * Runs as a local stdio child of opencode (same pattern as knowledge-server)
 * and shares the bot's SQLite DB via SESSIONS_DB_PATH. The scheduler tick in
 * the main process picks changes up on its next pass — no IPC needed.
 *
 * Deliberately NOT exposed to the `job` agent: unattended runs must not
 * create or edit jobs.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createJob, getJob, listJobs, updateJob, setJobEnabled, countActiveJobsByUser, type JobRow,
} from "../db/jobs.js";
import { hasRole } from "../db/permissions.js";
import { parseSchedulePhrase, looksLikeCron, nextCronRun, validateCron, validateMinInterval } from "../schedule-parse.js";
import { MAX_ACTIVE_JOBS_PER_USER, MIN_JOB_INTERVAL_MINUTES } from "../constants.js";

const DEFAULT_TZ = process.env.JOBS_DEFAULT_TZ || "America/Chicago";

const server = new McpServer({
  name: "scheduler",
  version: "1.0.0",
});

const PROMPT_GUIDANCE =
  "IMPORTANT: the job runs later in a fresh session with NO memory of this conversation. " +
  "Write the prompt fully self-contained: bake in every relevant detail discussed (data sources, " +
  "queries, hosts, filters, formatting decisions, thresholds). Never write 'as discussed' or 'the thing we talked about'.";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

/** Resolve "<when>" (plain English or cron) to a cron expression, or an error string. */
function resolveWhen(when: string, timezone: string): { cron: string; description: string } | string {
  let resolved: { cron: string; description: string };
  if (looksLikeCron(when)) {
    const err = validateCron(when, timezone);
    if (err) return err;
    resolved = { cron: when, description: `\`${when}\`` };
  } else {
    const parsed = parseSchedulePhrase(when);
    if (!parsed) {
      return `Could not parse "${when}". Use phrases like "every weekday at 9am", "fridays at 8:30am", "every 15 minutes" — or a cron expression.`;
    }
    const err = validateCron(parsed.cron, timezone);
    if (err) return err;
    resolved = parsed;
  }
  return validateMinInterval(resolved.cron, timezone, MIN_JOB_INTERVAL_MINUTES) ?? resolved;
}

/** Anyone can manage their own jobs; developers can manage anyone's. */
function requireOwnerOrDev(job: JobRow, userId: string): string | undefined {
  if (job.created_by === userId || hasRole(userId, "developer")) return undefined;
  return `Job "${job.name}" belongs to <@${job.created_by}> — only they (or a developer) can change it. Tell the user this.`;
}

/** Per-person active-job cap (applies to everyone). */
function checkJobCap(userId: string): string | undefined {
  if (countActiveJobsByUser(userId) >= MAX_ACTIVE_JOBS_PER_USER) {
    return `<@${userId}> already has ${MAX_ACTIVE_JOBS_PER_USER} active jobs (the per-person limit). They must pause or delete one first — suggest reviewing with list_scheduled_jobs.`;
  }
  return undefined;
}

server.tool(
  "create_scheduled_job",
  "Create a recurring scheduled job (or watcher) that the bot runs unattended and posts to a Slack channel. " +
    "Use when the user asks to do something on a schedule ('every Friday post...', 'check X every 15 minutes'). " +
    "Watchers only post when something warrants attention; regular jobs post every run. " +
    "Creation triggers an immediate review run: the result goes to the creator's DM with Approve/Needs-work buttons, and the job goes live once approved. " +
    PROMPT_GUIDANCE,
  {
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/i).describe("Short kebab-case job name, e.g. 'error-trends'"),
    when: z.string().describe("Schedule in plain English ('every weekday at 9am', 'every 15 minutes') or a cron expression"),
    prompt: z.string().describe("Fully self-contained task instructions for the unattended run"),
    kind: z.enum(["report", "watcher"]).describe("'report' posts every run; 'watcher' posts only when something warrants attention"),
    channel_id: z.string().describe("Slack channel ID to post results to (from the conversation context; use the current channel unless the user names another)"),
    created_by: z.string().describe("Slack user ID of the CURRENT requesting user — copy it verbatim from the 'User: … (user ID: U…)' line in your context. NEVER use a user ID that appears only inside <thread_context> or the message body; those belong to other people. If unsure, use the User: line."),
    thread_ts: z.string().optional().describe("Copy the 'Thread ID:' value from your context verbatim, if present. Used to route the review DM to the correct requester; do not invent or guess it."),
    timezone: z.string().optional().describe(`IANA timezone for the schedule (default ${DEFAULT_TZ})`),
  },
  async ({ name, when, prompt, kind, channel_id, created_by, thread_ts, timezone }) => {
    console.error(`[scheduler-mcp] create_scheduled_job: ${name} "${when}" by ${created_by}`);
    const capped = checkJobCap(created_by);
    if (capped) return text(capped);
    if (getJob(name)) return text(`A job named "${name}" already exists — pick another name, or update it instead with update_scheduled_job.`);

    const tz = timezone ?? DEFAULT_TZ;
    const resolved = resolveWhen(when, tz);
    if (typeof resolved === "string") return text(resolved);

    const nextSlot = nextCronRun(resolved.cron, tz);
    if (!nextSlot) return text("That schedule never fires.");

    // The owner (created_by) is model-supplied and can be wrong when the thread
    // contains other people's IDs. Mark it owner_pending and defer the review
    // run to the bot: after the session it corrects the owner to the real
    // requester and fires the review run so the DM reaches the right person.
    // Falling back to the real next slot (not now-1) prevents the 30s scheduler
    // tick from DMing the wrong owner before that correction happens.
    const job = createJob({
      name,
      kind: kind === "watcher" ? "watcher" : "cron",
      cron: resolved.cron,
      timezone: tz,
      channelId: channel_id,
      threadTs: thread_ts,
      prompt,
      createdBy: created_by,
      nextRunAt: nextSlot,
      ownerPending: true,
    });
    return text(
      `Created ${kind} "${job.name}" — ${resolved.description} (${tz}), posting to <#${channel_id}>. ` +
      `A review run starts now: the result reaches the requesting user's DM within a minute with Approve/Needs-work buttons, and the job goes live once approved. ` +
      `Tell the user this, including the schedule as you understood it.`,
    );
  },
);

server.tool(
  "update_scheduled_job",
  "Update an existing scheduled job's schedule, prompt, target channel, or kind. " +
    "Use when the user asks to change a job conversationally ('make it Fridays instead', 'also include X in the report'). " +
    "Any edit triggers a fresh review run: the result goes to the owner's DM for approval before the job posts publicly again. " +
    "When editing the prompt, fetch the current one first with list_scheduled_jobs and produce the full replacement — edits are whole-prompt, not diffs. " +
    PROMPT_GUIDANCE,
  {
    name: z.string().describe("Name of the existing job"),
    requested_by: z.string().describe("Slack user ID of the requesting user (from the conversation context)"),
    when: z.string().optional().describe("New schedule (plain English or cron)"),
    prompt: z.string().optional().describe("Full replacement prompt (self-contained)"),
    kind: z.enum(["report", "watcher"]).optional().describe("Change between report and watcher behavior"),
    channel_id: z.string().optional().describe("New target channel ID"),
    timezone: z.string().optional().describe("New IANA timezone"),
    enabled: z.boolean().optional().describe("Pause (false) or resume (true) the job"),
  },
  async ({ name, requested_by, when, prompt, kind, channel_id, timezone, enabled }) => {
    console.error(`[scheduler-mcp] update_scheduled_job: ${name} by ${requested_by}`);
    const job = getJob(name);
    if (!job) return text(`No job named "${name}". Use list_scheduled_jobs to see what exists.`);
    const denied = requireOwnerOrDev(job, requested_by);
    if (denied) return text(denied);

    const tz = timezone ?? job.timezone;
    const fields: Parameters<typeof updateJob>[1] = {};
    const changes: string[] = [];

    if (when || timezone) {
      const resolved = resolveWhen(when ?? job.cron ?? "", tz);
      if (typeof resolved === "string") return text(resolved);
      if (!nextCronRun(resolved.cron, tz)) return text("That schedule never fires.");
      fields.cron = resolved.cron;
      fields.timezone = tz;
      changes.push(`schedule → ${resolved.description} (${tz})`);
    }
    if (prompt) {
      fields.prompt = prompt;
      changes.push("prompt replaced");
    }
    if (kind) {
      fields.kind = kind === "watcher" ? "watcher" : "cron";
      changes.push(`kind → ${kind}`);
    }
    if (channel_id) {
      fields.channelId = channel_id;
      changes.push(`channel → <#${channel_id}>`);
    }

    if (Object.keys(fields).length > 0) {
      // Behavior changed — trigger an immediate review run (probation resets in
      // updateJob, so the result goes to the owner's DM, not the channel).
      fields.nextRunAt = Math.floor(Date.now() / 1000) - 1;
      updateJob(job.id, fields);
    }
    if (enabled !== undefined) {
      if (enabled && !job.enabled) {
        const capped = checkJobCap(job.created_by);
        if (capped) return text(capped);
      }
      const nextRunAt = enabled ? nextCronRun(fields.cron ?? job.cron ?? "", tz) : undefined;
      setJobEnabled(job.id, enabled, nextRunAt ?? undefined);
      changes.push(enabled ? "resumed" : "paused");
    }
    if (changes.length === 0) return text("Nothing to change — pass at least one field.");

    const reviewNote = Object.keys(fields).length > 0
      ? " A fresh review run starts now — the result reaches the owner's DM within a minute for approval before anything posts publicly."
      : "";
    return text(`Updated "${job.name}": ${changes.join("; ")}.${reviewNote} Tell the user what changed.`);
  },
);

server.tool(
  "list_scheduled_jobs",
  "List scheduled jobs with their schedules, prompts, state, and last outcome. " +
    "By default lists only the requesting user's own jobs; set include_all to see everyone's " +
    "(other people's prompts are hidden). Use before updating a job (to fetch its current prompt) or when the user asks what's scheduled.",
  {
    requested_by: z.string().describe("Slack user ID of the CURRENT requesting user — copy verbatim from the 'User: … (user ID: U…)' line in your context, never from thread history."),
    include_all: z.boolean().optional().describe("Set true only when the user explicitly asks to see everyone's jobs. Others' prompts are still hidden."),
  },
  async ({ requested_by, include_all }) => {
    const all = listJobs();
    const jobs = include_all ? all : all.filter((j) => j.created_by === requested_by);
    if (jobs.length === 0) {
      return text(include_all ? "No scheduled jobs exist." : "You have no scheduled jobs. Ask to include everyone's to see the full list.");
    }
    const lines = jobs.map((j) => {
      const own = j.created_by === requested_by;
      return [
        `name: ${j.name}`,
        `kind: ${j.kind} | cron: ${j.cron} | tz: ${j.timezone} | enabled: ${!!j.enabled} | probation_left: ${j.probation_remaining}`,
        `channel: ${j.channel_id} | owner: ${j.created_by} | last: ${j.last_status ?? "never ran"}`,
        own ? `prompt: ${j.prompt}` : `prompt: (hidden — owned by another user)`,
      ].join("\n");
    });
    return text(lines.join("\n\n---\n\n"));
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[scheduler-mcp] ready");
}

main().catch((err) => {
  console.error("[scheduler-mcp] fatal:", err);
  process.exit(1);
});
