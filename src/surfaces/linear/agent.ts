/**
 * Linear agent surface: turns agent-session webhooks into Q&A turns and posts
 * the answers back as agent activities. Each Linear agent session is one
 * thread (`linear:<agentSessionId>`).
 */
import type { TurnRunner } from "../../turn-runner.js";
import { retryWithDelays } from "../../utils/retry.js";
import type { ConversationContext, SurfaceTraits } from "../../conversation-context.js";
import type { Surface } from "../types.js";
import { ActivityQueue, type LinearApi, type LinearIdentity } from "./client.js";
import { LINEAR_SCOPE_ID } from "./config.js";

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

export const LINEAR_SURFACE: SurfaceTraits = {
  name: "Linear",
  messageNoun: "comments on a Linear issue, rendered as Markdown",
  formattingRules: ["Standard Markdown (headings, lists, tables, code blocks) renders normally in Linear."],
  notes: [
    "You were @mentioned in, or delegated, a Linear issue; the issue and its thread are in the user's question.",
    "Scheduling isn't available from Linear (it has to be set up in Slack), and memories must use `global` or `repo` scope, not `channel`.",
  ],
};

export interface LinearAgentDeps {
  linear: LinearApi;
  getIdentity: () => Promise<LinearIdentity>;
  /** Resolves once OpenCode is serving; events that arrive during boot wait for it. */
  ready: Promise<void>;
  runTurn: TurnRunner["runTurn"];
  stopThread: TurnRunner["stopThread"];
  activityRetryDelaysMs?: number[];
  identityRetryDelaysMs?: number[];
}

const STOPPED = "Stopped. I won't take any further action on this.";
const CAPPED_NOTE = "> ⚠️ I hit my time limit, so this is my best answer from what I gathered. It may be incomplete.\n\n";
/** Cap on remembered event keys and per-session activity queues. */
const MEMORY_LIMIT = 1000;

const threadKeyFor = (agentSessionId: string) => `linear:${agentSessionId}`;

/** One turn in a Linear agent session. */
class LinearTurnSurface implements Surface {
  readonly kind = "linear";
  readonly scopeId = LINEAR_SCOPE_ID;
  readonly threadKey: string;
  // The runner serializes turns in a thread, so one run key per session is enough.
  readonly runKey: string;

  constructor(private readonly activities: ActivityQueue, agentSessionId: string) {
    this.threadKey = threadKeyFor(agentSessionId);
    this.runKey = this.threadKey;
  }

  async queued(): Promise<void> {
    await this.activities.push({ type: "thought", body: "Got it. I'll pick this up after the current answer." }, { ephemeral: true });
  }

  async reply(markdown: string, { capped, failed }: { capped: boolean; failed: boolean }): Promise<void> {
    await this.activities.push(
      failed
        ? { type: "error", body: markdown }
        : { type: "response", body: capped ? CAPPED_NOTE + markdown : markdown },
    );
  }
}

export class LinearAgent {
  /** Per agent session, so activities post in order across turns. */
  private readonly activities = new Map<string, ActivityQueue>();
  private readonly seen = new Set<string>();
  /** Per agent session, so its events are handled in arrival order (a Stop can't overtake its mention). */
  private readonly inbox = new Map<string, Promise<void>>();
  private readonly turns = new Set<Promise<void>>();

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
    while (this.inbox.size > 0 || this.turns.size > 0) {
      await Promise.all([...this.inbox.values(), ...this.turns]);
    }
    await Promise.all([...this.activities.values()].map((a) => a.flush()));
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
    if (this.seen.size > MEMORY_LIMIT) this.seen.delete(this.seen.values().next().value!);

    const activities = this.activitiesFor(id);
    if (e.action === "prompted" && e.agentActivity?.signal === "stop") {
      const hadWork = this.deps.stopThread(threadKeyFor(id));
      await activities.push({ type: "response", body: hadWork ? STOPPED : "Nothing was running, so there was nothing to stop." });
      return;
    }

    let question: string;
    if (e.action === "created") {
      // Linear marks the session unresponsive without an activity within ~10s.
      void activities.push({ type: "thought", body: "Looking into this…" });
      question = e.promptContext?.trim() ?? "";
    } else if (e.action === "prompted") {
      question = e.agentActivity?.content?.body?.trim() ?? "";
      if (!question) return;
      void activities.push({ type: "thought", body: "Looking into this…" }, { ephemeral: true });
    } else {
      return;
    }
    if (!question) {
      void activities.push({ type: "error", body: "I couldn't find a question to answer." });
      return;
    }

    await this.deps.ready;
    const turn = this.answer(activities, id, question, contextFrom(e));
    this.turns.add(turn);
    void turn.finally(() => this.turns.delete(turn));
  }

  /** The webhook was already acknowledged, so retry a failed identity lookup before dropping the event. */
  private async identity(): Promise<LinearIdentity> {
    return retryWithDelays(this.deps.getIdentity, this.deps.identityRetryDelaysMs ?? [1_000, 3_000]);
  }

  /** Most recently used last, so the oldest idle session is evicted first. */
  private activitiesFor(id: string): ActivityQueue {
    const a = this.activities.get(id) ?? new ActivityQueue(this.deps.linear, id, this.deps.activityRetryDelaysMs);
    this.activities.delete(id);
    this.activities.set(id, a);
    if (this.activities.size > MEMORY_LIMIT) this.activities.delete(this.activities.keys().next().value!);
    return a;
  }

  private async answer(activities: ActivityQueue, id: string, question: string, context: ConversationContext): Promise<void> {
    try {
      await this.deps.runTurn(new LinearTurnSurface(activities, id), {
        question,
        context,
        waitForRestart: true,
      });
    } catch (err) {
      console.error(`[linear] ${id}: turn failed:`, err);
      void activities.push({ type: "error", body: "Sorry, something went wrong while I was answering. Please try again." });
    }
  }
}

function contextFrom(e: AgentSessionEvent): ConversationContext {
  const user = (e.action === "prompted" ? e.agentActivity?.user : null) ?? e.agentSession?.creator ?? undefined;
  const issue = e.agentSession?.issue ?? undefined;
  return {
    surface: LINEAR_SURFACE,
    requester: { id: user?.id ?? "unknown", name: user?.name ?? "A Linear user", email: user?.email },
    place: {
      label: "Issue",
      id: issue?.identifier ?? "unknown",
      name: issue?.title ?? issue?.identifier ?? "Linear issue",
      url: issue?.url,
    },
  };
}
