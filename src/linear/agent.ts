/**
 * Linear agent surface: turns Linear agent-session webhooks into OpenCode
 * Q&A turns and posts the results back as agent activities.
 *
 * One Linear agent session maps to one OpenCode session (thread key
 * `linear:<agentSessionId>`), so follow-up replies in the issue thread keep
 * their context the way Slack thread replies do. Turns within a session run
 * one at a time; follow-ups queue behind the current answer.
 */
import type { AskQuestionOpts, AskResult } from "../opencode.js";
import type { RepoInfo } from "../context-prefix.js";
import { ActivityQueue, type ActivityContent, type LinearApi, type LinearIdentity } from "./client.js";
import { LINEAR_CHANNEL_ID } from "./config.js";

// ── Webhook payload (the fields we use) ──

interface LinearUserRef {
  id?: string;
  name?: string;
  displayName?: string;
  email?: string;
}

export interface AgentSessionEventPayload {
  type?: string;
  action?: string;
  organizationId?: string;
  appUserId?: string;
  promptContext?: string;
  guidance?: unknown;
  agentSession?: {
    id?: string;
    url?: string;
    creator?: LinearUserRef | null;
    issue?: { id?: string; identifier?: string; title?: string; url?: string; description?: string | null } | null;
    comment?: { body?: string | null } | null;
  };
  agentActivity?: {
    id?: string;
    signal?: string | null;
    content?: { type?: string; body?: string | null } | null;
    user?: LinearUserRef | null;
  } | null;
}

/** Who is asking and about which issue — feeds the context prefix. */
export interface LinearTurnContext {
  userId?: string;
  userName: string;
  userEmail?: string;
  issueIdentifier?: string;
  issueTitle?: string;
  issueUrl?: string;
  /** Workspace/team agent guidance configured by Linear admins. */
  guidance?: string;
}

export interface LinearAgentDeps {
  linear: LinearApi;
  /** The app's own identity in the workspace; events for anyone else are dropped. */
  getIdentity: () => Promise<LinearIdentity>;
  /** Resolves once OpenCode is serving. Events that arrive during boot wait for it. */
  ready: Promise<void>;
  ask: (opts: AskQuestionOpts) => Promise<AskResult>;
  abortServerSide: (sessionId: string) => Promise<void>;
  sessions: {
    getOrCreate: (threadKey: string) => Promise<{ sessionId: string; isNew: boolean }>;
    remove: (threadKey: string) => void;
    isCompacted: (threadKey: string) => boolean;
    setCompacted: (threadKey: string, compacted: boolean) => void;
  };
  server: { isRestarting: () => boolean; waitForRestart: () => Promise<void> };
  buildContextPrefix: (ctx: LinearTurnContext, opts: { isNew: boolean; tools: string[]; repo?: RepoInfo }) => string;
  resolveRepo: () => RepoInfo | undefined;
  /** Effective MCP tools for the Linear agent, resolved per turn (tool config can change at runtime). */
  getTools: () => string[];
  agentName: string;
  turnCapMs: number;
  progressIntervalMs?: number;
  activityRetryDelaysMs?: number[];
}

interface Turn {
  question: string;
  generation: number;
  ctx: LinearTurnContext;
}

interface RunHandle {
  controller: AbortController;
  sessionId: string;
  stopRequested: boolean;
}

interface SessionState {
  id: string;
  activities: ActivityQueue;
  queue: Turn[];
  running: boolean;
  /** Bumped by stop: every turn from an older generation is dropped. */
  generation: number;
  current?: RunHandle;
  /** Set while a stop is aborting server-side; the next turn waits for it. */
  stopping?: Promise<void>;
  ctx: LinearTurnContext;
  lastUsed: number;
}

const SEEN_LIMIT = 1000;
const SESSION_IDLE_EVICT_MS = 6 * 60 * 60 * 1000;
const PROGRESS_THOUGHT_MAX_CHARS = 2000;
const CAPPED_NOTE =
  "> ⚠️ I hit my time limit before finishing the research, so this is my best answer from what I gathered. It may be incomplete.\n\n";
const GENERIC_FAILURE = "Sorry, something went wrong while I was answering. Please try again.";

export function threadKeyFor(agentSessionId: string): string {
  return `linear:${agentSessionId}`;
}

export class LinearAgent {
  private readonly sessions = new Map<string, SessionState>();
  private readonly seen = new Set<string>();

  constructor(private readonly deps: LinearAgentDeps) {}

  /** Entry point for a verified webhook payload. Never throws. */
  async handle(payload: unknown): Promise<void> {
    try {
      await this.handleEvent(payload as AgentSessionEventPayload);
    } catch (err) {
      console.error("[linear] Failed to handle webhook event:", err);
    }
  }

  /** Resolves when no session has queued or running work (used by tests). */
  async idle(): Promise<void> {
    for (;;) {
      const busy = [...this.sessions.values()].filter((s) => s.running || s.queue.length > 0);
      if (busy.length === 0) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all([...this.sessions.values()].map((s) => s.activities.flush()));
  }

  private async handleEvent(p: AgentSessionEventPayload): Promise<void> {
    if (p?.type !== "AgentSessionEvent") return;
    const agentSessionId = p.agentSession?.id;
    if (!agentSessionId) return;

    const identity = await this.deps.getIdentity();
    if (p.organizationId !== identity.organizationId) {
      console.warn(`[linear] Ignoring event for organization ${p.organizationId ?? "(none)"}`);
      return;
    }
    if (p.appUserId && p.appUserId !== identity.appUserId) {
      console.warn(`[linear] Ignoring event addressed to app user ${p.appUserId}`);
      return;
    }
    if (this.isDuplicate(p, agentSessionId)) return;

    const s = this.session(agentSessionId);
    s.ctx = mergeContext(s.ctx, contextFrom(p));

    if (p.action === "prompted" && p.agentActivity?.signal === "stop") {
      await this.stop(s);
      return;
    }

    let question: string;
    if (p.action === "created") {
      // Linear marks a session unresponsive without an activity within ~10s.
      void s.activities.push({ type: "thought", body: "Looking into this…" });
      question = questionFromCreated(p);
    } else if (p.action === "prompted") {
      question = p.agentActivity?.content?.body?.trim() ?? "";
      if (!question) return;
      void s.activities.push(
        {
          type: "thought",
          body: s.running ? "Got it. I'll pick this up when I finish the current answer." : "Looking into this…",
        },
        { ephemeral: true },
      );
    } else {
      return;
    }

    if (!question) {
      void s.activities.push({ type: "error", body: "I couldn't find a question in that. Mention me with what you'd like to know." });
      return;
    }

    s.queue.push({ question, generation: s.generation, ctx: { ...s.ctx } });
    void this.pump(s);
  }

  private isDuplicate(p: AgentSessionEventPayload, agentSessionId: string): boolean {
    const key = `${p.action}:${p.agentActivity?.id ?? agentSessionId}`;
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    return false;
  }

  private session(id: string): SessionState {
    const now = Date.now();
    let s = this.sessions.get(id);
    if (!s) {
      this.evictIdle(now);
      s = {
        id,
        activities: new ActivityQueue(this.deps.linear, id, this.deps.activityRetryDelaysMs),
        queue: [],
        running: false,
        generation: 0,
        ctx: { userName: "A Linear user" },
        lastUsed: now,
      };
      this.sessions.set(id, s);
    }
    s.lastUsed = now;
    return s;
  }

  private evictIdle(now: number): void {
    for (const [id, s] of this.sessions) {
      if (!s.running && s.queue.length === 0 && now - s.lastUsed > SESSION_IDLE_EVICT_MS) {
        this.sessions.delete(id);
      }
    }
  }

  private async stop(s: SessionState): Promise<void> {
    s.generation += 1;
    const hadWork = Boolean(s.current) || s.queue.length > 0;
    s.queue.length = 0;
    const run = s.current;
    if (run) {
      run.stopRequested = true;
      run.controller.abort();
    }
    // A reply sent right after Stop must not start on the OpenCode session
    // until the server-side abort has landed, or that abort would cancel it.
    const stopping = (async () => {
      if (run) await this.deps.abortServerSide(run.sessionId);
      await s.activities.push({
        type: "response",
        body: hadWork ? "Stopped. I won't take any further action on this." : "Nothing was running, so there was nothing to stop.",
      });
    })();
    s.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (s.stopping === stopping) s.stopping = undefined;
    }
  }

  private async pump(s: SessionState): Promise<void> {
    if (s.running) return;
    s.running = true;
    try {
      while (s.queue.length > 0) {
        const turn = s.queue.shift()!;
        if (turn.generation !== s.generation) continue;
        try {
          await this.runTurn(s, turn);
        } catch (err) {
          console.error(`[linear] ${s.id}: turn failed:`, err);
          if (turn.generation === s.generation) {
            void s.activities.push({ type: "error", body: GENERIC_FAILURE });
          }
        }
      }
    } finally {
      s.running = false;
    }
  }

  private async runTurn(s: SessionState, turn: Turn): Promise<void> {
    await this.deps.ready;
    while (s.stopping) await s.stopping.catch(() => {});
    if (this.deps.server.isRestarting()) await this.deps.server.waitForRestart();
    if (turn.generation !== s.generation) return;

    const threadKey = threadKeyFor(s.id);
    const { sessionId, isNew } = await this.deps.sessions.getOrCreate(threadKey);
    // After compaction, re-send the full instructions so the agent keeps its constraints.
    const needsFullContext = isNew || this.deps.sessions.isCompacted(threadKey);
    if (!isNew && needsFullContext) this.deps.sessions.setCompacted(threadKey, false);
    if (turn.generation !== s.generation) return;

    const tools = this.deps.getTools();
    const repo = this.deps.resolveRepo();
    const run: RunHandle = { controller: new AbortController(), sessionId, stopRequested: false };
    s.current = run;
    const progress = this.progressReporter(s);

    const askOpts: AskQuestionOpts = {
      sessionId,
      question: turn.question,
      customContextPrefix: this.deps.buildContextPrefix(turn.ctx, { isNew: needsFullContext, tools, repo }),
      isNewSession: needsFullContext,
      agent: this.deps.agentName,
      tools,
      repo,
      onProgress: progress.update,
      abortSignal: run.controller.signal,
      budget: { deadlineAt: Date.now() + this.deps.turnCapMs },
      salvageOnTimeout: true,
      analytics: {
        userId: turn.ctx.userId ? `linear:${turn.ctx.userId}` : "linear:unknown",
        channelId: LINEAR_CHANNEL_ID,
        channelName: turn.ctx.issueIdentifier ? `Linear ${turn.ctx.issueIdentifier}` : "Linear",
        threadKey,
      },
    };

    let result: AskResult;
    try {
      try {
        result = await this.deps.ask(askOpts);
      } catch (err) {
        // Stop already aborted the run and posted its response.
        if (run.stopRequested && isAbortError(err)) return;
        // A tool-config change restarted OpenCode mid-turn: wait it out and retry once.
        if (this.deps.server.isRestarting()) {
          await this.deps.server.waitForRestart();
          if (turn.generation !== s.generation) return;
          askOpts.budget = { deadlineAt: Date.now() + this.deps.turnCapMs };
          result = await this.deps.ask(askOpts);
        } else {
          throw err;
        }
      }
    } finally {
      progress.stop();
      if (s.current === run) s.current = undefined;
    }

    if (result.deadSession) {
      // The session never started the turn; retire the mapping so the next message gets a fresh one.
      this.deps.sessions.remove(threadKey);
      console.warn(`[linear] Retired wedged session mapping for ${threadKey} (session ${sessionId})`);
    }
    if (result.compacted) this.deps.sessions.setCompacted(threadKey, true);
    if (turn.generation !== s.generation) return;

    const content: ActivityContent = result.failed
      ? { type: "error", body: result.text }
      : { type: "response", body: result.capped ? CAPPED_NOTE + result.text : result.text };
    await s.activities.push(content);
  }

  /** Throttled, ephemeral progress activities while a turn runs. */
  private progressReporter(s: SessionState): { update: (status: string) => void; stop: () => void } {
    const intervalMs = this.deps.progressIntervalMs ?? 5_000;
    let lastSent = 0;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const flush = (): void => {
      if (stopped || pending === null) return;
      const content = progressActivity(pending);
      pending = null;
      lastSent = Date.now();
      if (content) void s.activities.push(content, { ephemeral: true });
    };

    return {
      update: (status: string) => {
        if (stopped) return;
        pending = status;
        const elapsed = Date.now() - lastSent;
        if (elapsed >= intervalMs) {
          flush();
        } else if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            flush();
          }, intervalMs - elapsed);
        }
      },
      stop: () => {
        stopped = true;
        pending = null;
        if (timer) clearTimeout(timer);
        timer = null;
      },
    };
  }
}

// ── Helpers ──

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.message === "Session aborted";
}

const USING_TOOLS_RE = /_Using: (.+?)\.\.\._\s*$/;

/**
 * Map a progress status from the OpenCode stream (latest draft text, possibly
 * followed by `_Using: tool, tool..._`) to an ephemeral Linear activity.
 */
export function progressActivity(status: string): ActivityContent | null {
  const using = status.match(USING_TOOLS_RE);
  if (using) return { type: "action", action: "Using", parameter: using[1] };
  const text = status.trim();
  if (!text) return null;
  const body = text.length > PROGRESS_THOUGHT_MAX_CHARS ? `${text.slice(0, PROGRESS_THOUGHT_MAX_CHARS)}…` : text;
  return { type: "thought", body };
}

/** The question for a new session: Linear's own prompt context (issue + thread), or a fallback built from the session. */
export function questionFromCreated(p: AgentSessionEventPayload): string {
  const promptContext = p.promptContext?.trim();
  if (promptContext) return promptContext;
  const parts: string[] = [];
  const issue = p.agentSession?.issue;
  if (issue) {
    parts.push([issue.identifier, issue.title].filter(Boolean).join(": "));
    if (issue.description) parts.push(issue.description);
  }
  const comment = p.agentSession?.comment?.body;
  if (comment) parts.push(comment);
  return parts.filter(Boolean).join("\n\n").trim();
}

function contextFrom(p: AgentSessionEventPayload): Partial<LinearTurnContext> {
  const user = (p.action === "prompted" ? p.agentActivity?.user : undefined) ?? p.agentSession?.creator ?? undefined;
  const issue = p.agentSession?.issue ?? undefined;
  return {
    userId: user?.id,
    userName: user?.name ?? user?.displayName,
    userEmail: user?.email,
    issueIdentifier: issue?.identifier,
    issueTitle: issue?.title,
    issueUrl: issue?.url ?? p.agentSession?.url,
    guidance: guidanceText(p.guidance),
  };
}

function mergeContext(base: LinearTurnContext, update: Partial<LinearTurnContext>): LinearTurnContext {
  const merged: LinearTurnContext = { ...base };
  for (const [k, v] of Object.entries(update) as Array<[keyof LinearTurnContext, string | undefined]>) {
    if (v) merged[k] = v;
  }
  return merged;
}

/** Guidance arrives as a list of rules; keep whatever text they carry. */
function guidanceText(guidance: unknown): string | undefined {
  if (!Array.isArray(guidance)) return undefined;
  const bodies = guidance
    .map((g) => {
      if (typeof g === "string") return g;
      if (g && typeof g === "object") {
        const body = (g as { body?: unknown; content?: unknown }).body ?? (g as { content?: unknown }).content;
        return typeof body === "string" ? body : "";
      }
      return "";
    })
    .map((b) => b.trim())
    .filter(Boolean);
  return bodies.length > 0 ? bodies.join("\n\n") : undefined;
}
