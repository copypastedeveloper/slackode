import { test } from "node:test";
import assert from "node:assert/strict";
import type { AskQuestionOpts, AskResult } from "../opencode.js";
import type { ActivityContent } from "./client.js";
import { LinearAgent, progressActivity, questionFromCreated, type LinearAgentDeps } from "./agent.js";

interface Posted {
  agentSessionId: string;
  content: ActivityContent;
  ephemeral: boolean;
}

const ANSWER: AskResult = { text: "Here is how it works.", isQuestion: false, compacted: false };

function harness(overrides: Partial<LinearAgentDeps> = {}) {
  const posted: Posted[] = [];
  const asks: AskQuestionOpts[] = [];
  const mappings = new Map<string, string>();
  const compacted = new Set<string>();
  const abortedServerSide: string[] = [];
  let created = 0;
  let askImpl: (opts: AskQuestionOpts) => Promise<AskResult> = async () => ANSWER;

  const deps: LinearAgentDeps = {
    linear: {
      createActivity: async (agentSessionId, content, opts) => {
        posted.push({ agentSessionId, content, ephemeral: Boolean(opts?.ephemeral) });
      },
    },
    getIdentity: async () => ({ appUserId: "app-user", organizationId: "org-narmi", organizationName: "Narmi" }),
    ready: Promise.resolve(),
    ask: (opts) => {
      asks.push(opts);
      return askImpl(opts);
    },
    abortServerSide: async (sessionId) => {
      abortedServerSide.push(sessionId);
    },
    sessions: {
      getOrCreate: async (threadKey) => {
        const existing = mappings.get(threadKey);
        if (existing) return { sessionId: existing, isNew: false };
        const sessionId = `oc-${++created}`;
        mappings.set(threadKey, sessionId);
        return { sessionId, isNew: true };
      },
      remove: (threadKey) => {
        mappings.delete(threadKey);
      },
      isCompacted: (threadKey) => compacted.has(threadKey),
      setCompacted: (threadKey, value) => {
        if (value) compacted.add(threadKey);
        else compacted.delete(threadKey);
      },
    },
    server: { isRestarting: () => false, waitForRestart: async () => {} },
    buildContextPrefix: (ctx, { isNew }) => `[new=${isNew} user=${ctx.userName} issue=${ctx.issueIdentifier ?? "-"}]\n`,
    resolveRepo: () => undefined,
    getTools: () => ["linear"],
    agentName: "linear",
    turnCapMs: 60_000,
    progressIntervalMs: 0,
    activityRetryDelaysMs: [],
    ...overrides,
  };

  return {
    agent: new LinearAgent(deps),
    deps,
    posted,
    asks,
    mappings,
    compacted,
    abortedServerSide,
    setAsk(fn: (opts: AskQuestionOpts) => Promise<AskResult>) {
      askImpl = fn;
    },
  };
}

function createdEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org-narmi",
    appUserId: "app-user",
    webhookTimestamp: Date.now(),
    promptContext: "<issue identifier=\"ENG-1\">How are statements generated?</issue>",
    agentSession: {
      id: "session-1",
      creator: { id: "user-ryan", name: "Ryan", email: "ryan@example.com" },
      issue: { identifier: "ENG-1", title: "Statements", url: "https://linear.app/narmi/issue/ENG-1" },
    },
    ...overrides,
  };
}

function promptedEvent(body: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "AgentSessionEvent",
    action: "prompted",
    organizationId: "org-narmi",
    appUserId: "app-user",
    webhookTimestamp: Date.now(),
    agentSession: { id: "session-1", issue: { identifier: "ENG-1", title: "Statements" } },
    agentActivity: { id: `activity-${body}`, content: { type: "prompt", body }, user: { id: "user-pat", name: "Pat" } },
    ...overrides,
  };
}

const durable = (posted: Posted[]) => posted.filter((p) => !p.ephemeral).map((p) => p.content);

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(check(), "condition never became true");
}

test("a mention posts a thought right away, then the answer", async () => {
  const h = harness();
  await h.agent.handle(createdEvent());
  await h.agent.idle();

  assert.deepEqual(durable(h.posted), [
    { type: "thought", body: "Looking into this…" },
    { type: "response", body: ANSWER.text },
  ]);
  assert.equal(h.asks.length, 1);
  const ask = h.asks[0];
  assert.equal(ask.question, "<issue identifier=\"ENG-1\">How are statements generated?</issue>");
  assert.equal(ask.agent, "linear");
  assert.equal(ask.isNewSession, true);
  assert.deepEqual(ask.tools, ["linear"]);
  assert.match(ask.customContextPrefix ?? "", /new=true user=Ryan issue=ENG-1/);
  assert.equal(ask.analytics?.channelId, "linear");
  assert.equal(ask.analytics?.threadKey, "linear:session-1");
  assert.equal(ask.analytics?.userId, "linear:user-ryan");
});

test("a follow-up reply continues the same OpenCode session", async () => {
  const h = harness();
  await h.agent.handle(createdEvent());
  await h.agent.idle();
  await h.agent.handle(promptedEvent("And for business accounts?"));
  await h.agent.idle();

  assert.equal(h.asks.length, 2);
  assert.equal(h.asks[1].sessionId, h.asks[0].sessionId);
  assert.equal(h.asks[1].question, "And for business accounts?");
  assert.equal(h.asks[1].isNewSession, false);
  assert.match(h.asks[1].customContextPrefix ?? "", /user=Pat issue=ENG-1/);
  assert.equal(durable(h.posted).filter((c) => c.type === "response").length, 2);
});

test("a follow-up sent mid-answer waits for the current answer", async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  h.setAsk(async (opts) => {
    if (opts.question.startsWith("<issue")) await gate;
    return { ...ANSWER, text: `answer to: ${opts.question.slice(0, 10)}` };
  });

  await h.agent.handle(createdEvent());
  await waitFor(() => h.asks.length === 1);
  await h.agent.handle(promptedEvent("follow-up"));
  assert.equal(h.asks.length, 1, "follow-up must not start while the first turn runs");
  release();
  await h.agent.idle();

  assert.deepEqual(
    durable(h.posted).filter((c) => c.type === "response").map((c) => (c as { body: string }).body),
    ["answer to: <issue ide", "answer to: follow-up"],
  );
});

test("stop aborts the running turn and drops queued follow-ups", async () => {
  const h = harness();
  h.setAsk((opts) => new Promise<AskResult>((_resolve, reject) => {
    opts.abortSignal?.addEventListener("abort", () => reject(new Error("Session aborted")));
  }));

  await h.agent.handle(createdEvent());
  await waitFor(() => h.asks.length === 1);
  await h.agent.handle(promptedEvent("queued follow-up"));
  await h.agent.handle(promptedEvent("", { agentActivity: { id: "stop-1", signal: "stop", content: { type: "prompt", body: "" } } }));
  await h.agent.idle();

  assert.equal(h.asks.length, 1, "the queued follow-up should be dropped");
  // Once when Stop arrives, once more after the turn settles.
  assert.deepEqual(h.abortedServerSide, [h.asks[0].sessionId, h.asks[0].sessionId]);
  const responses = durable(h.posted).filter((c) => c.type === "response");
  assert.deepEqual(responses, [{ type: "response", body: "Stopped. I won't take any further action on this." }]);
});

test("a reply sent right after Stop waits for the server-side abort", async () => {
  let releaseAbort!: () => void;
  const abortGate = new Promise<void>((r) => { releaseAbort = r; });
  const h = harness({ abortServerSide: () => abortGate });
  h.setAsk((opts) => {
    if (opts.question.startsWith("<issue")) {
      return new Promise<AskResult>((_resolve, reject) => {
        opts.abortSignal?.addEventListener("abort", () => reject(new Error("Session aborted")));
      });
    }
    return Promise.resolve({ ...ANSWER, text: "answer after stop" });
  });

  await h.agent.handle(createdEvent());
  await waitFor(() => h.asks.length === 1);
  // The webhook server doesn't await handle(); neither do we, so the stop is still in flight.
  void h.agent.handle(promptedEvent("", { agentActivity: { id: "stop-1", signal: "stop", content: { type: "prompt", body: "" } } }));
  void h.agent.handle(promptedEvent("new question"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.asks.length, 1, "the new turn must not start while the abort is pending");

  releaseAbort();
  await h.agent.idle();
  assert.equal(h.asks.length, 2);
  assert.deepEqual(
    durable(h.posted).filter((c) => c.type === "response").map((c) => (c as { body: string }).body),
    ["Stopped. I won't take any further action on this.", "answer after stop"],
  );
});

test("a second Stop doesn't let a reply start before the first abort lands", async () => {
  let releaseAbort!: () => void;
  const abortGate = new Promise<void>((r) => { releaseAbort = r; });
  const h = harness({ abortServerSide: () => abortGate });
  h.setAsk((opts) => {
    if (opts.question.startsWith("<issue")) {
      return new Promise<AskResult>((_resolve, reject) => {
        opts.abortSignal?.addEventListener("abort", () => reject(new Error("Session aborted")));
      });
    }
    return Promise.resolve({ ...ANSWER, text: "answer after stops" });
  });
  const stopEvent = (id: string) =>
    promptedEvent("", { agentActivity: { id, signal: "stop", content: { type: "prompt", body: "" } } });

  await h.agent.handle(createdEvent());
  await waitFor(() => h.asks.length === 1);
  void h.agent.handle(stopEvent("stop-1"));
  void h.agent.handle(stopEvent("stop-2"));
  void h.agent.handle(promptedEvent("new question"));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.asks.length, 1, "the reply must wait for the pending abort");

  releaseAbort();
  await h.agent.idle();
  assert.equal(h.asks.length, 2);
  assert.deepEqual(durable(h.posted).at(-1), { type: "response", body: "answer after stops" });
});

test("Stop during stream setup aborts again once the prompt has reached the server", async () => {
  const log: string[] = [];
  const h = harness({
    abortServerSide: async () => {
      log.push("abort");
    },
  });
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((r) => { releaseFirst = r; });
  h.setAsk(async (opts) => {
    if (opts.question.startsWith("<issue")) {
      // Simulates askQuestion dispatching the prompt without noticing the
      // abort (it was still opening the stream when Stop's abort landed).
      await firstGate;
      log.push("first turn settled");
      return ANSWER;
    }
    log.push("next turn started");
    return ANSWER;
  });

  await h.agent.handle(createdEvent());
  await waitFor(() => h.asks.length === 1);
  void h.agent.handle(promptedEvent("", { agentActivity: { id: "stop-1", signal: "stop", content: { type: "prompt", body: "" } } }));
  void h.agent.handle(promptedEvent("next"));
  await new Promise((r) => setTimeout(r, 10));
  releaseFirst();
  await h.agent.idle();

  assert.deepEqual(log, ["abort", "first turn settled", "abort", "next turn started"]);
  // The stopped turn's answer is discarded; only the next turn's is posted.
  const responses = durable(h.posted).filter((c) => c.type === "response").map((c) => (c as { body: string }).body);
  assert.deepEqual(responses, ["Stopped. I won't take any further action on this.", ANSWER.text]);
});

test("Stop during session setup still sends full instructions on the next reply", async () => {
  for (const startCompacted of [false, true]) {
    let releaseSetup!: () => void;
    const setupGate = new Promise<void>((r) => { releaseSetup = r; });
    const h = harness();
    const realGetOrCreate = h.deps.sessions.getOrCreate;
    if (startCompacted) {
      // An existing session whose context was compacted: it owes the full instructions.
      await realGetOrCreate("linear:session-1");
      h.compacted.add("linear:session-1");
    }
    let gateUsed = false;
    h.deps.sessions.getOrCreate = async (threadKey: string) => {
      const result = await realGetOrCreate(threadKey);
      if (!gateUsed) {
        gateUsed = true;
        await setupGate;
      }
      return result;
    };

    await h.agent.handle(createdEvent());
    await new Promise((r) => setTimeout(r, 10));
    void h.agent.handle(promptedEvent("", { agentActivity: { id: "stop-1", signal: "stop", content: { type: "prompt", body: "" } } }));
    await new Promise((r) => setTimeout(r, 10));
    releaseSetup();
    await h.agent.idle();
    assert.equal(h.asks.length, 0, "the stopped turn never asks");

    await h.agent.handle(promptedEvent("after stop"));
    await h.agent.idle();
    assert.equal(h.asks.length, 1);
    assert.equal(h.asks[0].isNewSession, true, `full instructions are sent (compacted=${startCompacted})`);
  }
});

test("Stop mid-answer on a new session still sends full instructions next time", async () => {
  const h = harness();
  h.setAsk((opts) => {
    if (opts.question.startsWith("<issue")) {
      return new Promise<AskResult>((_resolve, reject) => {
        opts.abortSignal?.addEventListener("abort", () => reject(new Error("Session aborted")));
      });
    }
    return Promise.resolve(ANSWER);
  });
  await h.agent.handle(createdEvent());
  await waitFor(() => h.asks.length === 1);
  await h.agent.handle(promptedEvent("", { agentActivity: { id: "stop-1", signal: "stop", content: { type: "prompt", body: "" } } }));
  await h.agent.idle();
  await h.agent.handle(promptedEvent("after stop"));
  await h.agent.idle();
  assert.equal(h.asks[1].isNewSession, true);
});

test("a redelivered event is handled once", async () => {
  const h = harness();
  await h.agent.handle(createdEvent());
  await h.agent.handle(createdEvent());
  await h.agent.idle();
  assert.equal(h.asks.length, 1);
});

test("events for another workspace or app user are ignored", async () => {
  const h = harness();
  await h.agent.handle(createdEvent({ organizationId: "org-other" }));
  await h.agent.handle(createdEvent({ appUserId: "someone-else", agentSession: { id: "session-2" } }));
  await h.agent.handle({ type: "Issue", action: "create" });
  await h.agent.idle();
  assert.equal(h.posted.length, 0);
  assert.equal(h.asks.length, 0);
});

test("a failed answer is posted as an error activity", async () => {
  const h = harness();
  h.setAsk(async () => ({ text: "Sorry — I ran out of time.", isQuestion: false, compacted: false, failed: true }));
  await h.agent.handle(createdEvent());
  await h.agent.idle();
  assert.deepEqual(durable(h.posted).at(-1), { type: "error", body: "Sorry — I ran out of time." });
});

test("an unexpected exception is reported without details", async () => {
  const h = harness();
  h.setAsk(async () => { throw new Error("socket hang up"); });
  await h.agent.handle(createdEvent());
  await h.agent.idle();
  const last = durable(h.posted).at(-1);
  assert.equal(last?.type, "error");
  assert.doesNotMatch((last as { body: string }).body, /socket/);
});

test("a wedged session's mapping is retired, and compaction is remembered", async () => {
  const h = harness();
  h.setAsk(async () => ({ text: "reset", isQuestion: false, compacted: false, failed: true, deadSession: true }));
  await h.agent.handle(createdEvent());
  await h.agent.idle();
  assert.equal(h.mappings.has("linear:session-1"), false);

  const h2 = harness();
  h2.setAsk(async () => ({ ...ANSWER, compacted: true }));
  await h2.agent.handle(createdEvent());
  await h2.agent.idle();
  assert.equal(h2.compacted.has("linear:session-1"), true);
  await h2.agent.handle(promptedEvent("next"));
  await h2.agent.idle();
  assert.equal(h2.asks[1].isNewSession, true, "full instructions are re-sent after compaction");
});

test("a capped answer is flagged as possibly incomplete", async () => {
  const h = harness();
  h.setAsk(async () => ({ ...ANSWER, capped: true }));
  await h.agent.handle(createdEvent());
  await h.agent.idle();
  const last = durable(h.posted).at(-1) as { type: string; body: string };
  assert.equal(last.type, "response");
  assert.match(last.body, /time limit/);
  assert.ok(last.body.endsWith(ANSWER.text));
});

test("events that arrive during startup wait until OpenCode is ready", async () => {
  let markReady!: () => void;
  const h = harness({ ready: new Promise<void>((r) => { markReady = r; }) });
  await h.agent.handle(createdEvent());
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(h.asks.length, 0);
  assert.deepEqual(durable(h.posted), [{ type: "thought", body: "Looking into this…" }]);
  markReady();
  await h.agent.idle();
  assert.equal(h.asks.length, 1);
});

test("progress updates are posted as ephemeral activities", async () => {
  const h = harness();
  h.setAsk(async (opts) => {
    opts.onProgress?.("_Using: bash, grep..._");
    // Let the update post before the answer: a queued answer supersedes it.
    await waitFor(() => h.posted.some((p) => p.ephemeral));
    return ANSWER;
  });
  await h.agent.handle(createdEvent());
  await h.agent.idle();
  assert.ok(h.posted.some((p) => p.ephemeral && p.content.type === "action"));
});

test("a progress update that's already superseded by the answer is skipped", async () => {
  const h = harness();
  h.setAsk(async (opts) => {
    opts.onProgress?.("draft");
    return ANSWER;
  });
  await h.agent.handle(createdEvent());
  await h.agent.idle();
  assert.equal(h.posted.at(-1)?.content.type, "response");
});

test("progressActivity maps stream statuses to Linear activities", () => {
  assert.deepEqual(progressActivity("_Using: bash, grep..._"), { type: "action", action: "Using", parameter: "bash, grep" });
  assert.deepEqual(progressActivity("Draft answer\n\n_Using: read..._"), { type: "action", action: "Using", parameter: "read" });
  assert.deepEqual(progressActivity("Draft answer"), { type: "thought", body: "Draft answer" });
  assert.equal(progressActivity("   "), null);
  const long = progressActivity("x".repeat(5000)) as { body: string };
  assert.ok(long.body.length <= 2001);
});

test("questionFromCreated falls back to the issue and comment without promptContext", () => {
  assert.equal(
    questionFromCreated({
      agentSession: {
        issue: { identifier: "ENG-2", title: "Limits", description: "What are the limits?" },
        comment: { body: "@slackode can you check?" },
      },
    }),
    "ENG-2: Limits\n\nWhat are the limits?\n\n@slackode can you check?",
  );
});
