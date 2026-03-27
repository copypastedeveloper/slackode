// ── Slack action IDs (must match between button definitions and action handlers) ──

export const Action = {
  CODING_STATUS: "coding_status",
  CODING_PR: "coding_pr",
  CODING_DONE: "coding_done",
  CODING_CANCEL: "coding_cancel",
  CODING_APPROVE: "coding_approve",
  CODING_REVISE: "coding_revise",
  /** Prefix for agent selection buttons: select_agent_0, select_agent_1, etc. */
  SELECT_AGENT_PREFIX: "select_agent_",
  /** Prefix for repo selection buttons: select_repo_0, select_repo_1, etc. */
  SELECT_REPO_PREFIX: "select_repo_",
} as const;

/** Maximum number of agent selection buttons (Slack allows 5 elements per actions block). */
export const MAX_AGENT_BUTTONS = 5;

/** Maximum number of repo selection buttons (Slack allows 5 elements per actions block). */
export const MAX_REPO_BUTTONS = 5;

// ── Slack block ID prefixes ──

export const BlockPrefix = {
  CODING_ACTIONS: "coding_actions_",
  CODING_PR: "coding_pr_",
  CODING_PLAN: "coding_plan_",
  AGENT_SELECT: "agent_select_",
  REPO_SELECT: "repo_select_",
} as const;

// ── Git identity for bot commits ──

export const GIT_AUTHOR = {
  name: "Slackode Bot",
  email: "bot@slackode.dev",
} as const;

// ── Paths that should never be committed from coding worktrees ──

export const BOT_MANAGED_PATHS = [".opencode", ".claude", ".agents", "opencode.json"] as const;

// ── Agent names considered internal (filtered out of agent selection) ──

export const INTERNAL_AGENT_NAMES = new Set([
  "plan", "general", "explore", "code", "build", "context",
  "summarizer", "compaction", "title", "summary", "enrich",
]);

export const INTERNAL_AGENT_PREFIX = "build-";

// ── Network ──

export const HOSTNAME = "127.0.0.1";
export const QA_SERVER_PORT = 4096;
export const CODING_BASE_PORT = 4100;

// ── Timeouts ──

export const REQUEST_TIMEOUT_MS = 10 * 60 * 1000; // 10 min — agent may run long bash commands
export const HEALTH_TIMEOUT_MS = 60_000;
export const HEALTH_POLL_MS = 1_000;

// ── Health check utility ──

export interface WaitForHealthOpts {
  url: string;
  label: string;
  timeoutMs?: number;
  pollMs?: number;
  /** If provided, called before each poll. Throw to abort early (e.g. process died). */
  check?: () => void;
}

/**
 * Poll a health endpoint until it returns 200, or timeout.
 */
export async function waitForHealth(opts: WaitForHealthOpts): Promise<void> {
  const { url, label, timeoutMs = HEALTH_TIMEOUT_MS, pollMs = HEALTH_POLL_MS, check } = opts;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check) check();
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (resp.ok) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`[server] ${label} ready (took ${elapsed}s)`);
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`${label} failed to start within ${timeoutMs / 1000}s`);
}
