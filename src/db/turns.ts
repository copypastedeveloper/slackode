import { getDb } from "./index.js";

// ── Turn analytics ──

export type TurnOutcome =
  | "success"
  | "empty"
  | "aborted"
  | "timeout"
  | "too_long"
  | "provider_error"
  | "error";

export interface RecordTurnInput {
  userId: string;
  channelId: string;
  channelName?: string;
  threadKey?: string;
  sessionId?: string;
  agent?: string;
  repoName?: string;
  toolsEnabled?: string[];
  toolsUsed?: Array<{ name: string; calls: number }>;
  skillsUsed?: string[];
  questionChars?: number;
  responseChars?: number;
  durationMs?: number;
  stepCount?: number;
  outcome: TurnOutcome;
  outcomeDetail?: string;
  compacted?: boolean;
}

/**
 * Record one turn (question/answer round) for analytics.
 * Safe to call from any return path in askQuestion. Swallows errors so analytics
 * never fail the user-visible response.
 */
export function recordTurn(input: RecordTurnInput): void {
  try {
    getDb().prepare(`
      INSERT INTO turns (
        user_id, channel_id, channel_name, thread_key, session_id,
        agent, repo_name, tools_enabled, tools_used, skills_used,
        question_chars, response_chars, duration_ms, step_count,
        outcome, outcome_detail, compacted
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?
      )
    `).run(
      input.userId,
      input.channelId,
      input.channelName ?? null,
      input.threadKey ?? null,
      input.sessionId ?? null,
      input.agent ?? null,
      input.repoName ?? null,
      input.toolsEnabled && input.toolsEnabled.length > 0 ? input.toolsEnabled.join(",") : null,
      input.toolsUsed && input.toolsUsed.length > 0 ? JSON.stringify(input.toolsUsed) : null,
      input.skillsUsed && input.skillsUsed.length > 0 ? JSON.stringify(input.skillsUsed) : null,
      input.questionChars ?? null,
      input.responseChars ?? null,
      input.durationMs ?? null,
      input.stepCount ?? null,
      input.outcome,
      input.outcomeDetail ?? null,
      input.compacted ? 1 : 0,
    );
  } catch (err) {
    console.warn("[turns] recordTurn failed:", err);
  }
}

// ── Stats queries ──

export interface StatsSummary {
  totalTurns: number;
  uniqueUsers: number;
  uniqueChannels: number;
  outcomeCounts: Record<string, number>;
  /** [{ user_id, count }] top N */
  topUsers: Array<{ user_id: string; count: number }>;
  /** [{ channel_id, channel_name, count }] top N */
  topChannels: Array<{ channel_id: string; channel_name: string | null; count: number }>;
  /** Latency percentiles in ms across successful turns only */
  latency: { p50: number | null; p95: number | null };
  /** Step-count percentiles across successful turns */
  steps: { p50: number | null; p95: number | null };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx];
}

/**
 * Aggregate turn stats for [sinceTs, now]. Optional userId/channelId filters
 * narrow the window.
 */
export function getStatsSummary(opts: {
  sinceTs: number;
  userId?: string;
  channelId?: string;
  topN?: number;
}): StatsSummary {
  const db = getDb();
  const topN = opts.topN ?? 5;
  const whereClauses = ["ts >= ?"];
  const whereParams: Array<string | number> = [opts.sinceTs];
  if (opts.userId) { whereClauses.push("user_id = ?"); whereParams.push(opts.userId); }
  if (opts.channelId) { whereClauses.push("channel_id = ?"); whereParams.push(opts.channelId); }
  const where = whereClauses.join(" AND ");

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS totalTurns,
      COUNT(DISTINCT user_id) AS uniqueUsers,
      COUNT(DISTINCT channel_id) AS uniqueChannels
    FROM turns WHERE ${where}
  `).get(...whereParams) as { totalTurns: number; uniqueUsers: number; uniqueChannels: number };

  const outcomeRows = db.prepare(`
    SELECT outcome, COUNT(*) AS n FROM turns WHERE ${where} GROUP BY outcome
  `).all(...whereParams) as Array<{ outcome: string; n: number }>;
  const outcomeCounts: Record<string, number> = {};
  for (const r of outcomeRows) outcomeCounts[r.outcome] = r.n;

  const topUsers = db.prepare(`
    SELECT user_id, COUNT(*) AS count FROM turns WHERE ${where}
    GROUP BY user_id ORDER BY count DESC LIMIT ?
  `).all(...whereParams, topN) as Array<{ user_id: string; count: number }>;

  const topChannels = db.prepare(`
    SELECT channel_id, MAX(channel_name) AS channel_name, COUNT(*) AS count
    FROM turns WHERE ${where}
    GROUP BY channel_id ORDER BY count DESC LIMIT ?
  `).all(...whereParams, topN) as Array<{ channel_id: string; channel_name: string | null; count: number }>;

  const durations = db.prepare(`
    SELECT duration_ms FROM turns
    WHERE ${where} AND outcome = 'success' AND duration_ms IS NOT NULL
    ORDER BY duration_ms ASC
  `).all(...whereParams) as Array<{ duration_ms: number }>;
  const sortedDur = durations.map((r) => r.duration_ms);

  const steps = db.prepare(`
    SELECT step_count FROM turns
    WHERE ${where} AND outcome = 'success' AND step_count IS NOT NULL
    ORDER BY step_count ASC
  `).all(...whereParams) as Array<{ step_count: number }>;
  const sortedSteps = steps.map((r) => r.step_count);

  return {
    totalTurns: totals.totalTurns,
    uniqueUsers: totals.uniqueUsers,
    uniqueChannels: totals.uniqueChannels,
    outcomeCounts,
    topUsers,
    topChannels,
    latency: { p50: percentile(sortedDur, 0.5), p95: percentile(sortedDur, 0.95) },
    steps: { p50: percentile(sortedSteps, 0.5), p95: percentile(sortedSteps, 0.95) },
  };
}
