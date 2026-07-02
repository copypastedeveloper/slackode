import type { WebClient } from "@slack/web-api";
import { hasRole } from "../sessions.js";
import {
  createJob, getJob, listJobs, deleteJob, setJobEnabled,
  decrementProbation, getRecentRuns, getJobCost, type JobRow,
} from "../db/jobs.js";
import { parseSchedulePhrase, looksLikeCron, nextCronRun, validateCron } from "../schedule-parse.js";
import { runJob } from "../job-runner.js";

const DEFAULT_TZ = process.env.JOBS_DEFAULT_TZ || "America/Chicago";

const HELP = [
  "*Scheduled jobs* — recurring work the bot does unattended (queries, analysis, digests), posting results to a channel. For static reminders, use Slack's `/remind` instead.",
  "",
  "• `schedule add <name> \"<when>\" <prompt>` — posts every run",
  "  e.g. `schedule add repo-digest \"every friday at 4pm\" Summarize this week's merged changes and flag anything risky.`",
  "• `schedule watch <name> \"<when>\" <prompt>` — posts *only* when something warrants attention",
  "  e.g. `schedule watch error-trends \"every 15 minutes\" Check OpenSearch for new error trends and raise anything that looks like an incident.`",
  "• `\"<when>\"` takes plain English (`\"every weekday at 9am\"`, `\"mondays at 8:30am\"`, `\"every 15 minutes\"`) or a cron expression. Flags: `--tz <zone>`, `--channel <#chan>`.",
  "• `schedule list` / `schedule show <name>`",
  "• `schedule run <name>` — fire it now",
  "• `schedule pause <name>` / `schedule resume <name>` / `schedule delete <name>`",
  "",
  "New jobs run on probation: the first 3 results come to your DM with *Post to channel / Needs work / Pause job* buttons instead of posting publicly.",
].join("\n");

/**
 * Handle `schedule ...` commands. Returns a reply string, or undefined when
 * the message isn't a schedule command (falls through to Q&A).
 */
export async function handleScheduleCommand(
  question: string,
  channelId: string,
  userId: string,
  client: WebClient,
): Promise<string | undefined> {
  const match = question.match(/^schedule\s*(.*)$/is);
  if (!match) return undefined;
  const rest = match[1].trim();

  if (!rest || /^help$/i.test(rest)) return HELP;

  const [sub] = rest.split(/\s+/, 1);
  const args = rest.slice(sub.length).trim();

  switch (sub.toLowerCase()) {
    case "list":
      return renderList();
    case "show":
      return renderShow(args);
    case "add":
      return requireDev(userId) ?? handleAdd(args, channelId, userId, "cron");
    case "watch":
      return requireDev(userId) ?? handleAdd(args, channelId, userId, "watcher");
    case "pause":
      return requireDev(userId) ?? toggle(args, false);
    case "resume":
      return requireDev(userId) ?? toggle(args, true);
    case "delete":
      return requireDev(userId) ?? handleDelete(args);
    case "approve":
      return requireDev(userId) ?? handleApprove(args);
    case "run":
      return requireDev(userId) ?? handleRun(args, client);
    default:
      return HELP;
  }
}

function requireDev(userId: string): string | undefined {
  if (!hasRole(userId, "developer")) {
    return "This command requires *developer* permissions. Ask an admin to run `role add @you developer`.";
  }
  return undefined;
}

function handleAdd(args: string, channelId: string, userId: string, kind: "cron" | "watcher"): string {
  // schedule add|watch <name> "<when>" [--tz <zone>] [--channel <#C…|…>] <prompt…>
  const verb = kind === "watcher" ? "watch" : "add";
  const m = args.match(/^(\S+)\s+"([^"]+)"\s+([\s\S]+)$/);
  if (!m) {
    return kind === "watcher"
      ? 'Usage: `schedule watch <name> "<when>" <prompt>` — e.g. `schedule watch error-trends "every 15 minutes" Check OpenSearch for new error trends and raise anything that looks like an incident.`'
      : 'Usage: `schedule add <name> "<when>" <prompt>` — e.g. `schedule add repo-digest "every friday at 4pm" Summarize this week\'s merged changes and flag anything risky.`';
  }
  const [, name, when] = m;
  let prompt = m[3].trim();

  if (!/^[a-z0-9][a-z0-9-]*$/i.test(name)) {
    return "Job names must be alphanumeric with dashes (e.g. `ai-utilization-weekly`).";
  }
  if (getJob(name)) {
    return `A job named \`${name}\` already exists. Pick another name or \`schedule delete ${name}\` first.`;
  }

  let timezone = DEFAULT_TZ;
  const tzMatch = prompt.match(/^--tz\s+(\S+)\s+([\s\S]+)$/);
  if (tzMatch) {
    timezone = tzMatch[1];
    prompt = tzMatch[2].trim();
  }
  let targetChannel = channelId;
  const chanMatch = prompt.match(/^--channel\s+<#([A-Z0-9]+)(?:\|[^>]*)?>\s+([\s\S]+)$/);
  if (chanMatch) {
    targetChannel = chanMatch[1];
    prompt = chanMatch[2].trim();
  }
  if (!prompt) return "The job needs a prompt describing what to do.";

  // "<when>" accepts plain English or a raw cron expression.
  let cron: string;
  let whenDesc: string;
  if (looksLikeCron(when)) {
    const cronError = validateCron(when, timezone);
    if (cronError) return cronError;
    cron = when;
    whenDesc = `\`${cron}\``;
  } else {
    const parsed = parseSchedulePhrase(when);
    if (!parsed) {
      return `I couldn't parse "${when}". Try phrases like \`"every weekday at 9am"\`, \`"fridays at 8:30am"\`, \`"every 15 minutes"\` — or a cron expression.`;
    }
    const cronError = validateCron(parsed.cron, timezone);
    if (cronError) return cronError;
    cron = parsed.cron;
    whenDesc = `${parsed.description} (\`${cron}\`)`;
  }

  const nextRunAt = nextCronRun(cron, timezone);
  if (!nextRunAt) return "That schedule never fires.";

  const job = createJob({
    name, kind, cron, timezone,
    channelId: targetChannel, prompt, createdBy: userId, nextRunAt,
  });

  const watcherNote = kind === "watcher"
    ? " It only posts when something warrants attention — quiet runs are normal."
    : "";
  return [
    `:calendar: Created ${kind === "watcher" ? "watcher" : "job"} \`${job.name}\` — ${whenDesc} (${timezone}), posting to <#${targetChannel}>.${watcherNote}`,
    `Next run: ${fmtTime(nextRunAt)}. The first ${job.probation_remaining} results come to your DM with approval buttons before anything posts publicly.`,
  ].join("\n");
}

function toggle(name: string, enabled: boolean): string {
  const job = getJob(name.trim());
  if (!job) return unknownJob(name);
  if (enabled) {
    if (job.kind !== "cron" || !job.cron) return `\`${job.name}\` is a ${job.kind} job and can't be resumed.`;
    const nextRunAt = nextCronRun(job.cron, job.timezone);
    setJobEnabled(job.id, true, nextRunAt);
    return `:arrow_forward: Resumed \`${job.name}\` — next run ${nextRunAt ? fmtTime(nextRunAt) : "never"}.`;
  }
  setJobEnabled(job.id, false);
  return `:double_vertical_bar: Paused \`${job.name}\`. \`schedule resume ${job.name}\` to re-enable.`;
}

function handleDelete(name: string): string {
  const job = getJob(name.trim());
  if (!job) return unknownJob(name);
  deleteJob(job.id);
  return `:wastebasket: Deleted \`${job.name}\` and its run history.`;
}

function handleApprove(name: string): string {
  const job = getJob(name.trim());
  if (!job) return unknownJob(name);
  if (job.probation_remaining <= 0) return `\`${job.name}\` is already out of probation.`;
  decrementProbation(job.id);
  const left = job.probation_remaining - 1;
  return left > 0
    ? `:white_check_mark: Approved. ${left} probation run${left === 1 ? "" : "s"} left for \`${job.name}\`.`
    : `:white_check_mark: Approved — \`${job.name}\` is out of probation and will post directly to <#${job.channel_id}>.`;
}

function handleRun(name: string, client: WebClient): string {
  const job = getJob(name.trim());
  if (!job) return unknownJob(name);
  // Fire and forget — the runner reports its own outcome (post or failure DM).
  runJob(job, client, { manual: true }).catch((err) =>
    console.error(`[jobs] manual run of ${job.name} failed:`, err),
  );
  return `:rocket: Running \`${job.name}\` now — results will post to <#${job.channel_id}>.`;
}

function renderList(): string {
  const jobs = listJobs();
  if (jobs.length === 0) return "No scheduled jobs yet. `schedule help` to create one.";
  const lines = jobs.map((j) => {
    const state = j.enabled ? (j.next_run_at ? `next ${fmtTime(j.next_run_at)}` : "no next run") : "paused";
    const probation = j.probation_remaining > 0 ? ` · :test_tube: ${j.probation_remaining} approvals left` : "";
    return `• \`${j.name}\` — ${j.kind} \`${j.cron ?? ""}\` → <#${j.channel_id}> (${state}${j.last_status ? ` · last: ${j.last_status}` : ""}${probation})`;
  });
  return ["*Scheduled jobs*", ...lines].join("\n");
}

function renderShow(name: string): string {
  const job = getJob(name.trim());
  if (!job) return unknownJob(name);
  const runs = getRecentRuns(job.id);
  const runLines = runs.length
    ? runs.map((r) => `• ${fmtTime(r.started_at)} — ${r.status}${r.error ? `: ${r.error.slice(0, 120)}` : ""}`)
    : ["• (no runs yet)"];
  return [
    `*\`${job.name}\`* — ${job.kind} \`${job.cron ?? ""}\` (${job.timezone}) → <#${job.channel_id}>`,
    `Owner: <@${job.created_by}> · ${job.enabled ? "enabled" : "paused"} · probation left: ${job.probation_remaining}`,
    `Next run: ${job.next_run_at ? fmtTime(job.next_run_at) : "—"}`,
    `Prompt: ${job.prompt.length > 400 ? job.prompt.slice(0, 400) + "…" : job.prompt}`,
    renderCost(job.name),
    "",
    "*Recent runs*",
    ...runLines,
  ].join("\n");
}

function renderCost(name: string): string {
  const cost = getJobCost(name);
  if (cost.turns === 0) return "Cost: no runs recorded yet";
  const perRun = cost.costUsd / cost.turns;
  const fmt = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n);
  const dollars = cost.costUsd > 0
    ? ` · $${cost.costUsd.toFixed(2)} total ($${perRun.toFixed(3)}/run)`
    : " · $ n/a (provider does not report per-token cost)";
  return `Cost: ${cost.turns} runs · ${fmt(cost.inputTokens)} in / ${fmt(cost.outputTokens)} out tokens (${fmt(cost.cacheReadTokens)} cached)${dollars}`;
}

function unknownJob(name: string): string {
  return `No job named \`${name.trim()}\`. \`schedule list\` to see what exists.`;
}

function fmtTime(unixSeconds: number): string {
  // Slack renders this in each viewer's local timezone.
  return `<!date^${unixSeconds}^{date_short_pretty} {time}|${new Date(unixSeconds * 1000).toISOString()}>`;
}

export type { JobRow };
