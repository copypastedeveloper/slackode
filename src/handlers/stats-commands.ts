import prettyMs from "pretty-ms";
import { getStatsSummary, type StatsSummary } from "../db/turns.js";

/** Compact number formatter — 1234 → "1.2K", 1234567 → "1.2M". Native; no deps. */
const compactNum = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

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
    `• ${plural(s.uniqueThreads, "thread")} from ${plural(s.uniqueUsers, "user")} across ${plural(s.uniqueChannels, "channel")}`,
    `• ${plural(s.totalTurns, "turn")} total (avg ${ratio(s.totalTurns, s.uniqueThreads, 1)} per thread)`,
  ];
  const outcomeLine = formatOutcomes(s.outcomeCounts, s.totalTurns);
  if (outcomeLine) lines.push(`• ${outcomeLine}`);
  if (s.latency.p50 !== null) lines.push(`• latency: p50 ${fmtMs(s.latency.p50)}, p95 ${fmtMs(s.latency.p95)}`);
  const tokenLine = formatTokensAndCost(s.totals);
  if (tokenLine) lines.push(`• ${tokenLine}`);
  if (s.topUsers.length > 0) {
    lines.push("", "*Top users (by threads)*");
    for (const u of s.topUsers) lines.push(`• <@${u.user_id}> — ${plural(u.threads, "thread")} (${plural(u.count, "turn")})`);
  }
  if (s.topChannels.length > 0) {
    lines.push("", "*Top channels (by threads)*");
    for (const c of s.topChannels) {
      const label = c.channel_name ? `#${c.channel_name}` : `<#${c.channel_id}>`;
      lines.push(`• ${label} — ${plural(c.threads, "thread")} (${plural(c.count, "turn")})`);
    }
  }
  return lines.join("\n");
}

function renderUser(s: StatsSummary, userId: string, windowLabel: string): string {
  if (s.totalTurns === 0) return `*Stats for <@${userId}> (${windowLabel})*\nNo activity yet.`;
  const lines = [
    `*Stats for <@${userId}> (${windowLabel})*`,
    `• ${plural(s.uniqueThreads, "thread")} across ${plural(s.uniqueChannels, "channel")}`,
    `• ${plural(s.totalTurns, "turn")} total`,
  ];
  const outcomeLine = formatOutcomes(s.outcomeCounts, s.totalTurns);
  if (outcomeLine) lines.push(`• ${outcomeLine}`);
  if (s.latency.p50 !== null) lines.push(`• latency: p50 ${fmtMs(s.latency.p50)}, p95 ${fmtMs(s.latency.p95)}`);
  const tokenLine = formatTokensAndCost(s.totals);
  if (tokenLine) lines.push(`• ${tokenLine}`);
  if (s.topChannels.length > 0) {
    lines.push("", "*Channels used*");
    for (const c of s.topChannels) {
      const label = c.channel_name ? `#${c.channel_name}` : `<#${c.channel_id}>`;
      lines.push(`• ${label} — ${plural(c.threads, "thread")}`);
    }
  }
  return lines.join("\n");
}

function renderChannel(s: StatsSummary, channelId: string, windowLabel: string): string {
  if (s.totalTurns === 0) return `*Stats for <#${channelId}> (${windowLabel})*\nNo activity yet.`;
  const lines = [
    `*Stats for <#${channelId}> (${windowLabel})*`,
    `• ${plural(s.uniqueThreads, "thread")} from ${plural(s.uniqueUsers, "user")}`,
    `• ${plural(s.totalTurns, "turn")} total`,
  ];
  const outcomeLine = formatOutcomes(s.outcomeCounts, s.totalTurns);
  if (outcomeLine) lines.push(`• ${outcomeLine}`);
  if (s.latency.p50 !== null) lines.push(`• latency: p50 ${fmtMs(s.latency.p50)}, p95 ${fmtMs(s.latency.p95)}`);
  const tokenLine = formatTokensAndCost(s.totals);
  if (tokenLine) lines.push(`• ${tokenLine}`);
  if (s.topUsers.length > 0) {
    lines.push("", "*Top users*");
    for (const u of s.topUsers) lines.push(`• <@${u.user_id}> — ${plural(u.threads, "thread")}`);
  }
  return lines.join("\n");
}

function renderQuality(s: StatsSummary, windowLabel: string): string {
  if (s.totalTurns === 0) return `*Quality (${windowLabel})*\nNo activity yet.`;
  const lines = [
    `*Quality (${windowLabel})*`,
    `• ${plural(s.uniqueThreads, "thread")} / ${plural(s.totalTurns, "turn")}`,
  ];
  for (const [outcome, n] of Object.entries(s.outcomeCounts).sort((a, b) => b[1] - a[1])) {
    const pct = Math.round((n / s.totalTurns) * 100);
    lines.push(`  • ${outcome}: ${n} (${pct}%)`);
  }
  if (s.latency.p50 !== null) lines.push("", `*Latency on success*`, `• p50: ${fmtMs(s.latency.p50)}`, `• p95: ${fmtMs(s.latency.p95)}`);
  if (s.steps.p50 !== null) lines.push("", `*Step counts on success*`, `• p50: ${s.steps.p50}`, `• p95: ${s.steps.p95}`);
  const tokenLine = formatTokensAndCost(s.totals);
  if (tokenLine) lines.push("", `*Usage*`, `• ${tokenLine}`);
  return lines.join("\n");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function ratio(num: number, den: number, decimals: number): string {
  if (den === 0) return "—";
  return (num / den).toFixed(decimals);
}

function formatTokensAndCost(t: StatsSummary["totals"]): string | null {
  if (t.inputTokens === 0 && t.outputTokens === 0 && t.costUsd === 0) return null;
  const parts: string[] = [];
  if (t.inputTokens > 0 || t.outputTokens > 0) {
    parts.push(`${fmtTokens(t.inputTokens)} in / ${fmtTokens(t.outputTokens)} out`);
  }
  if (t.cacheReadTokens > 0 || t.cacheWriteTokens > 0) {
    parts.push(`cache: ${fmtTokens(t.cacheReadTokens)} read, ${fmtTokens(t.cacheWriteTokens)} write`);
  }
  if (t.costUsd > 0) parts.push(`$${t.costUsd.toFixed(4)}`);
  return parts.join(" · ");
}

function fmtTokens(n: number): string {
  return compactNum.format(n);
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
  return prettyMs(ms, { secondsDecimalDigits: 1, millisecondsDecimalDigits: 0 });
}
