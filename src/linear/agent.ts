/**
 * Linear agent: turns agent-session webhooks into OpenCode Q&A turns and posts
 * the answers back as agent activities. Each Linear agent session maps to one
 * OpenCode session (`linear:<agentSessionId>`), so replies in the issue thread
 * keep their context. Turns in a session run one at a time.
 */
import type { AskQuestionOpts, AskResult } from "../opencode.js";
import type { RepoInfo } from "../context-prefix.js";
import { ActivityQueue, type LinearApi, type LinearIdentity } from "./client.js";
import { LINEAR_CHANNEL_ID } from "./config.js";

interface LinearUser {
  id?: string;
  name?: string;
  email?: string;
}

/** The fields of an `AgentSessionEvent` webhook we use. */
interface AgentSessionEvent {
  type?: string;
  action?: string;
  organizationId?: string;
  appUserId?: string;
  promptContext?: string;
  agentSession?: {
    id?: string;
    creator?: LinearUser | null;
    issue?: { identifier?: string; title?: string; url?: string } | null;
  };
  agentActivity?: {
    id?: string;
    signal?: string | null;
    content?: { body?: string | null } | null;
    user?: LinearUser | null;
  } | null;
}

/** Who is asking and about which issue; feeds the context prefix. */
export interface LinearTurnContext {
  userId?: string;
  userName: string;
  userEmail?: string;
  issueIdentifier?: string;
  issueTitle?: string;
  issueUrl?: string;
}

export interface LinearAgentDeps {
  linear: LinearApi;
  getIdentity: () => Promise<LinearIdentity>;
  /** Resolves once OpenCode is serving; events that arrive during boot wait for it. */
  ready: Promise<void>;
  ask: (opts: AskQuestionOpts) => Promise<AskResult>;
  abortServerSide: (sessionId: string) => Promise<void>;
  sessions: {
    getOrCreate: (threadKey: string) => Promise<{ sessionId: string; isNew: boolean }>;
    remove: (threadKey: string) => void;
    isCompacted: (threadKey: string) => boolean;
    setCompacted: (threadKey: string, compacted: boolean) => void;
  };
  waitForRestart: () => Promise<void>;
  buildContextPrefix: (ctx: LinearTurnContext, opts: { isNew: boolean; tools: string[]; repo?: RepoInfo }) => string;
  resolveRepo: () => RepoInfo | undefined;
  getTools: () => string[];
  agentName: string;
  turnCapMs: number;
  activityRetryDelaysMs?: number[];
  identityRetryDelaysMs?: number[];
}

interface Turn {
  question: string;
  generation: number;
  ctx: LinearTurnContext;
}

interface Run {
  controller: AbortController;
  sessionId: string;
  stopRequested: boolean;
  serverAbort?: Promise<void>;
}

interface Session {
  id: string;
  activities: ActivityQueue;
  queue: Turn[];
  running: boolean;
  /** Bumped by Stop; turns from an older generation are dropped. */
  generation: number;
  current?: Run;
}

const STOPPED = "Stopped. I won't take any further action on this.";
const CAPPED_NOTE = "> ⚠️ I hit my time limit, so this is my best answer from what I gathered. It may be incomplete.\n\n";
const SEEN_LIMIT = 1000;

export class LinearAgent {
  private readonly sessions = new Map<string, Session>();
  private readonly seen = new Set<string>();
  /** Per agent session, so its events are handled in arrival order (a Stop can't overtake its mention). */
  private readonly inbox = new Map<string, Promise<void>>();

  constructor(private readonly deps: LinearAgentDeps) {}

  /** Entry point for a verified webhook payload. Never throws. */
  async handle(payload: unknown): Promise<void> {
    const e = payload as AgentSessionEvent;
    const key = e?.agentSession?.id ?? "";
    const next = (this.inbox.get(key) ?? Promise.resolve())
      .then(() => this.handleEvent(e))
      .catch((err) => console.error("[linear] Failed to handle webhook event:", err));
    this.inbox.set(key, next);
    await next;
    if (this.inbox.get(key) === next) this.inbox.delete(key);
  }

  /** Resolves once no event or turn is pending (for tests). */
  async idle(): Promise<void> {
    await Promise.all(this.inbox.values());
    while ([...this.sessions.values()].some((s) => s.running || s.queue.length > 0)) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await Promise.all([...this.sessions.values()].map((s) => s.activities.flush()));
  }

  private async handleEvent(e: AgentSessionEvent): Promise<void> {
    const id = e?.type === "AgentSessionEvent" ? e.agentSession?.id : undefined;
    if (!id) return;

    const me = await this.identity();
    if (e.organizationId !== me.organizationId || (e.appUserId && e.appUserId !== me.appUserId)) {
      console.warn("[linear] Ignoring an event for another workspace or app");
      return;
    }

    // Linear retries deliveries; handle each event once.
    const key = `${e.action}:${e.agentActivity?.id ?? id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!);

    const s = this.session(id);
    if (e.action === "prompted" && e.agentActivity?.signal === "stop") {
      await this.stop(s);
      return;
    }

    let question: string;
    if (e.action === "created") {
      // Linear marks the session unresponsive without an activity within ~10s.
      void s.activities.push({ type: "thought", body: "Looking into this…" });
      question = e.promptContext?.trim() ?? "";
    } else if (e.action === "prompted") {
      question = e.agentActivity?.content?.body?.trim() ?? "";
      if (!question) return;
      const ack = s.running ? "Got it. I'll pick this up after the current answer." : "Looking into this…";
      void s.activities.push({ type: "thought", body: ack }, { ephemeral: true });
    } else {
      return;
    }
    if (!question) {
      void s.activities.push({ type: "error", body: "I couldn't find a question to answer." });
      return;
    }

    s.queue.push({ question, generation: s.generation, ctx: contextFrom(e) });
    void this.pump(s);
  }

  /** The webhook was already acknowledged, so retry a failed identity lookup before dropping the event. */
  private async identity(): Promise<LinearIdentity> {
    const delays = this.deps.identityRetryDelaysMs ?? [1_000, 3_000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.deps.getIdentity();
      } catch (err) {
        if (attempt >= delays.length) throw err;
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }

  private session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        id,
        activities: new ActivityQueue(this.deps.linear, id, this.deps.activityRetryDelaysMs),
        queue: [],
        running: false,
        generation: 0,
      };
      this.sessions.set(id, s);
    }
    return s;
  }

  /**
   * Cancel the running turn and drop queued ones. The server-side abort starts
   * now so a long tool call ends promptly; the running turn waits for it before
   * finishing, so the next turn can't start (and be cancelled by it) until it lands.
   */
  private async stop(s: Session): Promise<void> {
    s.generation += 1;
    const run = s.current;
    const hadWork = s.running || s.queue.length > 0;
    s.queue.length = 0;
    if (run && !run.stopRequested) {
      run.stopRequested = true;
      run.controller.abort();
      run.serverAbort = this.deps.abortServerSide(run.sessionId);
    }
    await s.activities.push({ type: "response", body: hadWork ? STOPPED : "Nothing was running, so there was nothing to stop." });
  }

  private async pump(s: Session): Promise<void> {
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
            void s.activities.push({ type: "error", body: "Sorry, something went wrong while I was answering. Please try again." });
          }
        }
      }
    } finally {
      s.running = false;
    }
  }

  private async runTurn(s: Session, turn: Turn): Promise<void> {
    await this.deps.ready;
    await this.deps.waitForRestart();
    if (turn.generation !== s.generation) return;

    const threadKey = `linear:${s.id}`;
    const { sessionId, isNew } = await this.deps.sessions.getOrCreate(threadKey);
    // New or compacted sessions get the full instructions, as in Slack. If this
    // turn fails or is stopped, keep them owed so the next turn still sends them.
    const needsFullContext = isNew || this.deps.sessions.isCompacted(threadKey);
    const keepFullContextOwed = () => {
      if (needsFullContext) this.deps.sessions.setCompacted(threadKey, true);
    };
    if (turn.generation !== s.generation) return keepFullContextOwed();
    if (!isNew && needsFullContext) this.deps.sessions.setCompacted(threadKey, false);

    const tools = this.deps.getTools();
    const repo = this.deps.resolveRepo();
    const run: Run = { controller: new AbortController(), sessionId, stopRequested: false };
    s.current = run;

    let result: AskResult | undefined;
    try {
      result = await this.deps.ask({
        sessionId,
        question: turn.question,
        customContextPrefix: this.deps.buildContextPrefix(turn.ctx, { isNew: needsFullContext, tools, repo }),
        isNewSession: needsFullContext,
        agent: this.deps.agentName,
        tools,
        repo,
        abortSignal: run.controller.signal,
        budget: { deadlineAt: Date.now() + this.deps.turnCapMs },
        salvageOnTimeout: true,
        analytics: {
          userId: `linear:${turn.ctx.userId ?? "unknown"}`,
          channelId: LINEAR_CHANNEL_ID,
          channelName: `Linear ${turn.ctx.issueIdentifier ?? ""}`.trim(),
          threadKey,
        },
      });
    } catch (err) {
      const aborted = err instanceof Error && err.message === "Session aborted";
      if (!(run.stopRequested && aborted)) throw err;
    } finally {
      if (!result || run.stopRequested) keepFullContextOwed();
      if (run.stopRequested) {
        // The prompt may have reached the server after Stop's abort (e.g. while
        // the stream was still opening): abort once more before the next turn.
        await run.serverAbort?.catch(() => {});
        await this.deps.abortServerSide(sessionId).catch(() => {});
      }
      s.current = undefined;
    }
    if (!result) return;

    // Same session bookkeeping as the Slack path.
    if (result.deadSession) this.deps.sessions.remove(threadKey);
    if (result.compacted) this.deps.sessions.setCompacted(threadKey, true);
    if (turn.generation !== s.generation) return;

    await s.activities.push(
      result.failed
        ? { type: "error", body: result.text }
        : { type: "response", body: result.capped ? CAPPED_NOTE + result.text : result.text },
    );
  }
}

function contextFrom(e: AgentSessionEvent): LinearTurnContext {
  const user = (e.action === "prompted" ? e.agentActivity?.user : null) ?? e.agentSession?.creator ?? undefined;
  const issue = e.agentSession?.issue ?? undefined;
  return {
    userId: user?.id,
    userName: user?.name ?? "A Linear user",
    userEmail: user?.email,
    issueIdentifier: issue?.identifier,
    issueTitle: issue?.title,
    issueUrl: issue?.url,
  };
}
