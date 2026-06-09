import { getStatsSummary, type StatsSummary } from "../db/turns.js";

/**
 * Handle `stats` Slack commands.
 *
 *   stats                  → last 24h overview (totals, outcomes, top users, top channels, latency)
 *   stats --day            → same as bare `stats`
 *   stats --week           → last 7 days
 *   stats --month          → last 30 days
 *   stats --user @uid      → that user's volume across the default 24h window
 *   stats --channel #cid   → that channel's volume across the default 24h window
 *   stats --quality        → outcome breakdown + latency/step percentiles
 *
 * Read-only — open to all users.
 */
export function handleStatsCommand(command: string): string | null {
  const m = command.trim().match(/^stats\b(.*)$/i);
  if (!m) return null;
  const args = m[1].trim();

  const flags = parseFlags(args);
  const window = pickWindow(flags);
  const sinceTs = Math.floor(Date.now() / 1000) - window.seconds;

  const summary = getStatsSummary({
    sinceTs,
    userId: flags.userId,
    channelId: flags.channelId,
  });

  if (flags.quality) return renderQuality(summary, window.label);
  if (flags.userId) return renderUser(summary, flags.userId, window.label);
  if (flags.channelId) return renderChannel(summary, flags.channelId, window.label);
  return renderOverview(summary, window.label);
}

interface ParsedFlags {
  scope: "day" | "week" | "month";
  userId?: string;
  channelId?: string;
  quality: boolean;
}

function parseFlags(args: string): ParsedFlags {
  const flags: ParsedFlags = { scope: "day", quality: false };
  // --week / --month / --day
  if (/--week\b/i.test(args)) flags.scope = "week";
  else if (/--month\b/i.test(args)) flags.scope = "month";
  else if (/--day\b/i.test(args)) flags.scope = "day";
  if (/--quality\b/i.test(args)) flags.quality = true;
  // --user @U123 or --user U123 — Slack expands mentions to <@U123>
  const userMatch = args.match(/--user\s+(?:<@([A-Z0-9]+)(?:\|[^>]+)?>|@?([A-Z0-9]+))/i);
  if (userMatch) flags.userId = userMatch[1] ?? userMatch[2];
  // --channel #C123 or --channel C123 — Slack expands mentions to <#C123|name>
  const chanMatch = args.match(/--channel\s+(?:<#([A-Z0-9]+)(?:\|[^>]+)?>|#?([A-Z0-9]+))/i);
  if (chanMatch) flags.channelId = chanMatch[1] ?? chanMatch[2];
  return flags;
}

function pickWindow(flags: ParsedFlags): { label: string; seconds: number } {
  switch (flags.scope) {
    case "week": return { label: "last 7 days", seconds: 7 * 24 * 60 * 60 };
    case "month": return { label: "last 30 days", seconds: 30 * 24 * 60 * 60 };
    default: return { label: "last 24 hours", seconds: 24 * 60 * 60 };
  }
}

function renderOverview(s: StatsSummary, windowLabel: string): string {
  if (s.totalTurns === 0) return `*Stats (${windowLabel})*\nNo activity yet.`;
  const lines = [
    `*Stats (${windowLabel})*`,
    `• ${s.totalTurns} turn${s.totalTurns === 1 ? "" : "s"} from ${s.uniqueUsers} user${s.uniqueUsers === 1 ? "" : "s"} across ${s.uniqueChannels} channel${s.uniqueChannels === 1 ? "" : "s"}`,
  ];
  const outcomeLine = formatOutcomes(s.outcomeCounts, s.totalTurns);
  if (outcomeLine) lines.push(`• ${outcomeLine}`);
  if (s.latency.p50 !== null) lines.push(`• latency: p50 ${fmtMs(s.latency.p50)}, p95 ${fmtMs(s.latency.p95)}`);
  if (s.steps.p50 !== null) lines.push(`• steps: p50 ${s.steps.p50}, p95 ${s.steps.p95}`);
  if (s.topUsers.length > 0) {
    lines.push("", "*Top users*");
    for (const u of s.topUsers) lines.push(`• <@${u.user_id}> — ${u.count}`);
  }
  if (s.topChannels.length > 0) {
    lines.push("", "*Top channels*");
    for (const c of s.topChannels) {
      const label = c.channel_name ? `#${c.channel_name}` : `<#${c.channel_id}>`;
      lines.push(`• ${label} — ${c.count}`);
    }
  }
  return lines.join("\n");
}

function renderUser(s: StatsSummary, userId: string, windowLabel: string): string {
  if (s.totalTurns === 0) return `*Stats for <@${userId}> (${windowLabel})*\nNo activity yet.`;
  const lines = [
    `*Stats for <@${userId}> (${windowLabel})*`,
    `• ${s.totalTurns} turn${s.totalTurns === 1 ? "" : "s"} across ${s.uniqueChannels} channel${s.uniqueChannels === 1 ? "" : "s"}`,
  ];
  const outcomeLine = formatOutcomes(s.outcomeCounts, s.totalTurns);
  if (outcomeLine) lines.push(`• ${outcomeLine}`);
  if (s.latency.p50 !== null) lines.push(`• latency: p50 ${fmtMs(s.latency.p50)}, p95 ${fmtMs(s.latency.p95)}`);
  if (s.topChannels.length > 0) {
    lines.push("", "*Channels used*");
    for (const c of s.topChannels) {
      const label = c.channel_name ? `#${c.channel_name}` : `<#${c.channel_id}>`;
      lines.push(`• ${label} — ${c.count}`);
    }
  }
  return lines.join("\n");
}

function renderChannel(s: StatsSummary, channelId: string, windowLabel: string): string {
  if (s.totalTurns === 0) return `*Stats for <#${channelId}> (${windowLabel})*\nNo activity yet.`;
  const lines = [
    `*Stats for <#${channelId}> (${windowLabel})*`,
    `• ${s.totalTurns} turn${s.totalTurns === 1 ? "" : "s"} from ${s.uniqueUsers} user${s.uniqueUsers === 1 ? "" : "s"}`,
  ];
  const outcomeLine = formatOutcomes(s.outcomeCounts, s.totalTurns);
  if (outcomeLine) lines.push(`• ${outcomeLine}`);
  if (s.latency.p50 !== null) lines.push(`• latency: p50 ${fmtMs(s.latency.p50)}, p95 ${fmtMs(s.latency.p95)}`);
  if (s.topUsers.length > 0) {
    lines.push("", "*Top users*");
    for (const u of s.topUsers) lines.push(`• <@${u.user_id}> — ${u.count}`);
  }
  return lines.join("\n");
}

function renderQuality(s: StatsSummary, windowLabel: string): string {
  if (s.totalTurns === 0) return `*Quality (${windowLabel})*\nNo activity yet.`;
  const lines = [
    `*Quality (${windowLabel})*`,
    `• ${s.totalTurns} turn${s.totalTurns === 1 ? "" : "s"} total`,
  ];
  for (const [outcome, n] of Object.entries(s.outcomeCounts).sort((a, b) => b[1] - a[1])) {
    const pct = Math.round((n / s.totalTurns) * 100);
    lines.push(`  • ${outcome}: ${n} (${pct}%)`);
  }
  if (s.latency.p50 !== null) lines.push("", `*Latency on success*`, `• p50: ${fmtMs(s.latency.p50)}`, `• p95: ${fmtMs(s.latency.p95)}`);
  if (s.steps.p50 !== null) lines.push("", `*Step counts on success*`, `• p50: ${s.steps.p50}`, `• p95: ${s.steps.p95}`);
  return lines.join("\n");
}

function formatOutcomes(outcomeCounts: Record<string, number>, total: number): string {
  const success = outcomeCounts.success ?? 0;
  const failures = total - success;
  if (failures === 0) return `all successful`;
  const pct = Math.round((failures / total) * 100);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(outcomeCounts)) {
    if (k === "success") continue;
    parts.push(`${v} ${k}`);
  }
  return `${success} success, ${parts.join(", ")} (${pct}% non-success)`;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}
