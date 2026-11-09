import { test } from "node:test";
import assert from "node:assert/strict";
import type { AskQuestionOpts, AskResult } from "../opencode.js";
import type { ActivityContent } from "./client.js";
import { LinearAgent, type LinearAgentDeps } from "./agent.js";

const ANSWER: AskResult = { text: "Here is how it works.", isQuestion: false, compacted: false };
const STOPPED = "Stopped. I won't take any further action on this.";

function harness(overrides: Partial<LinearAgentDeps> = {}) {
  const posted: Array<{ content: ActivityContent; ephemeral: boolean }> = [];
  const asks: AskQuestionOpts[] = [];
  const aborts: string[] = [];
  const mappings = new Map<string, string>();
  const compacted = new Set<string>();
  let askImpl: (opts: AskQuestionOpts) => Promise<AskResult> = async () => ANSWER;

  const deps: LinearAgentDeps = {
    linear: { createActivity: async (_id, content, opts) => { posted.push({ content, ephemeral: Boolean(opts?.ephemeral) }); } },
    getIdentity: async () => ({ appUserId: "app-user", organizationId: "org-narmi", organizationName: "Narmi" }),
    ready: Promise.resolve(),
    ask: (opts) => { asks.push(opts); return askImpl(opts); },
    abortServerSide: async (sessionId) => { aborts.push(sessionId); },
    sessions: {
      getOrCreate: async (key) => {
        const existing = mappings.get(key);
        if (existing) return { sessionId: existing, isNew: false };
        mappings.set(key, `oc-${mappings.size + 1}`);
        return { sessionId: mappings.get(key)!, isNew: true };
      },
      remove: (key) => { mappings.delete(key); },
      isCompacted: (key) => compacted.has(key),
      setCompacted: (key, value) => { if (value) compacted.add(key); else compacted.delete(key); },
    },
    server: { isRestarting: () => false, waitForRestart: async () => {} },
    buildContextPrefix: (ctx) => `[${ctx.userName} on ${ctx.issueIdentifier}]\n`,
    resolveRepo: () => undefined,
    getTools: () => ["linear"],
    agentName: "linear",
    turnCapMs: 60_000,
    progressIntervalMs: 0,
    activityRetryDelaysMs: [],
    identityRetryDelaysMs: [0],
    ...overrides,
  };

  return {
    agent: new LinearAgent(deps),
    asks,
    aborts,
    mappings,
    compacted,
    durable: () => posted.filter((p) => !p.ephemeral).map((p) => p.content),
    setAsk(fn: (opts: AskQuestionOpts) => Promise<AskResult>) { askImpl = fn; },
  };
}

const created = (overrides: Record<string, unknown> = {}) => ({
  type: "AgentSessionEvent",
  action: "created",
  organizationId: "org-narmi",
  appUserId: "app-user",
  promptContext: "How are statements generated?",
  agentSession: {
    id: "session-1",
    creator: { id: "user-ryan", name: "Ryan" },
    issue: { identifier: "ENG-1", title: "Statements" },
  },
  ...overrides,
});

const prompted = (body: string, activity: Record<string, unknown> = {}) => ({
  type: "AgentSessionEvent",
  action: "prompted",
  organizationId: "org-narmi",
  appUserId: "app-user",
  agentSession: { id: "session-1", issue: { identifier: "ENG-1" } },
  agentActivity: { id: `activity-${body}-${activity.signal ?? ""}`, content: { body }, user: { name: "Pat" }, ...activity },
});

const stop = () => prompted("", { signal: "stop" });

/** An ask that only ends when its run is aborted. */
const hangUntilAborted = (opts: AskQuestionOpts) =>
  new Promise<AskResult>((_resolve, reject) => {
    opts.abortSignal?.addEventListener("abort", () => reject(new Error("Session aborted")));
  });

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "condition never became true");
}

test("a mention posts a thought right away, then the answer", async () => {
  const h = harness();
  await h.agent.handle(created());
  await h.agent.idle();

  assert.deepEqual(h.durable(), [
    { type: "thought", body: "Looking into this…" },
    { type: "response", body: ANSWER.text },
  ]);
  const [ask] = h.asks;
  assert.equal(ask.question, "How are statements generated?");
  assert.equal(ask.agent, "linear");
  assert.equal(ask.isNewSession, true);
  assert.equal(ask.analytics?.threadKey, "linear:session-1");
});

test("a reply continues the session, queued behind a running answer", async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  h.setAsk(async (opts) => {
    if (opts.question.startsWith("How")) await gate;
    return ANSWER;
  });

  await h.agent.handle(created());
  await waitFor(() => h.asks.length === 1);
  await h.agent.handle(prompted("And for business accounts?"));
  assert.equal(h.asks.length, 1, "the reply must wait for the running turn");
  release();
  await h.agent.idle();

  assert.equal(h.asks[1].sessionId, h.asks[0].sessionId);
  assert.equal(h.asks[1].isNewSession, false);
  assert.match(h.asks[1].customContextPrefix ?? "", /Pat on ENG-1/);
});

test("Stop aborts the run, and a reply sent after it waits for the abort", async () => {
  let releaseAbort!: () => void;
  const abortGate = new Promise<void>((r) => { releaseAbort = r; });
  let abortCalls = 0;
  // Only Stop's immediate abort is slow; the turn's follow-up abort returns at once.
  const h = harness({ abortServerSide: () => (abortCalls++ === 0 ? abortGate : Promise.resolve()) });
  h.setAsk((opts) => (opts.question.startsWith("How") ? hangUntilAborted(opts) : Promise.resolve(ANSWER)));

  await h.agent.handle(created());
  await waitFor(() => h.asks.length === 1);
  await h.agent.handle(prompted("queued before stop"));
  // The webhook server doesn't await handle(), so these overlap like real deliveries.
  void h.agent.handle(stop());
  void h.agent.handle(prompted("", { id: "stop-2", signal: "stop" }));
  void h.agent.handle(prompted("sent after stop"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.asks.length, 1, "nothing new may start while the server-side abort is pending");

  releaseAbort();
  await h.agent.idle();
  assert.deepEqual(h.asks.map((a) => a.question), ["How are statements generated?", "sent after stop"]);
  assert.deepEqual(h.durable().filter((c) => c.type === "response"), [
    { type: "response", body: STOPPED },
    { type: "response", body: STOPPED },
    { type: "response", body: ANSWER.text },
  ]);
});

test("a stopped run is aborted again once it settles", async () => {
  // askQuestion can dispatch the prompt after Stop's first abort has landed
  // (Stop while the stream was opening), so the turn aborts once more.
  const log: string[] = [];
  const h = harness({ abortServerSide: async () => { log.push("abort"); } });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  h.setAsk(async () => {
    await gate;
    log.push("settled");
    return ANSWER;
  });

  await h.agent.handle(created());
  await waitFor(() => h.asks.length === 1);
  await h.agent.handle(stop());
  release();
  await h.agent.idle();

  assert.deepEqual(log, ["abort", "settled", "abort"]);
  assert.deepEqual(h.durable().at(-1), { type: "response", body: STOPPED }, "the stopped turn's answer isn't posted");
});

test("a turn that fails or is stopped still owes the full instructions", async () => {
  const failed = harness();
  failed.setAsk(async () => {
    if (failed.asks.length === 1) throw new Error("connect ECONNREFUSED");
    return ANSWER;
  });
  await failed.agent.handle(created());
  await failed.agent.idle();
  assert.equal(failed.durable().at(-1)?.type, "error");
  await failed.agent.handle(prompted("retry"));
  await failed.agent.idle();
  assert.deepEqual(failed.asks.map((a) => a.isNewSession), [true, true]);

  const stopped = harness();
  stopped.setAsk((opts) => (opts.question.startsWith("How") ? hangUntilAborted(opts) : Promise.resolve(ANSWER)));
  await stopped.agent.handle(created());
  await waitFor(() => stopped.asks.length === 1);
  await stopped.agent.handle(stop());
  await stopped.agent.idle();
  await stopped.agent.handle(prompted("after stop"));
  await stopped.agent.idle();
  assert.deepEqual(stopped.asks.map((a) => a.isNewSession), [true, true]);
});

test("a failed answer is posted as an error activity", async () => {
  const h = harness();
  h.setAsk(async () => ({ text: "Sorry — I ran out of time.", isQuestion: false, compacted: false, failed: true }));
  await h.agent.handle(created());
  await h.agent.idle();
  assert.deepEqual(h.durable().at(-1), { type: "error", body: "Sorry — I ran out of time." });
});

test("redeliveries and events for other workspaces or apps are ignored", async () => {
  const h = harness();
  await h.agent.handle(created({ organizationId: "org-other" }));
  await h.agent.handle(created({ appUserId: "another-app" }));
  await h.agent.handle(created());
  await h.agent.handle(created());
  await h.agent.idle();
  assert.equal(h.asks.length, 1);
});

test("a transient identity failure is retried instead of dropping the event", async () => {
  let attempts = 0;
  const h = harness({
    getIdentity: async () => {
      if (++attempts === 1) throw new Error("HTTP 503");
      return { appUserId: "app-user", organizationId: "org-narmi", organizationName: "Narmi" };
    },
  });
  await h.agent.handle(created());
  await h.agent.idle();
  assert.equal(h.asks.length, 1);
});
