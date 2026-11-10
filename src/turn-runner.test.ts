import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { AskQuestionOpts, AskResult } from "./opencode.js";
import type { ActiveRun } from "./run-registry.js";
import type { Surface } from "./surfaces/types.js";
import type { ConversationContext } from "./conversation-context.js";
import type { ScopeConfig } from "./scope-config.js";
import { createTurnRunner, type TurnRequest, type TurnRunnerDeps } from "./turn-runner.js";

const context: ConversationContext = {
  surface: { name: "Test", messageNoun: "test messages", formattingRules: [] },
  requester: { id: "U1", name: "Ada" },
  place: { label: "Room", id: "R1", name: "lobby" },
};
const req = (extra: Partial<TurnRequest> = {}): TurnRequest => ({ question: "q", context, ...extra });

class FakeSurface implements Surface {
  readonly kind = "fake";
  readonly scopeId = "scope1";
  events: string[] = [];
  replies: { markdown: string; sessionId: string; capped: boolean; failed: boolean }[] = [];

  constructor(readonly threadKey = "t1", readonly runKey = "run1") {}

  async restarting() { this.events.push("restarting"); }
  async queued() { this.events.push("queued"); }
  progress(status: string) { this.events.push(`progress:${status}`); }
  begin() { this.events.push("begin"); }
  async end() { this.events.push("end"); }
  async stopped() { this.events.push("stopped"); }
  async reply(markdown: string, meta: { sessionId: string; capped: boolean; failed: boolean }) {
    this.events.push("reply");
    this.replies.push({ markdown, ...meta });
  }
}

function setup(overrides: {
  ask?: (opts: AskQuestionOpts) => Promise<AskResult>;
  isNew?: boolean;
  compacted?: boolean;
  restarting?: () => boolean;
  scope?: ScopeConfig;
  getOrCreate?: TurnRunnerDeps["sessions"]["getOrCreate"];
} = {}) {
  const runs = new Map<string, ActiveRun>();
  const compacted = new Map<string, boolean>([["t1", overrides.compacted ?? false]]);
  const removed: string[] = [];
  const asks: AskQuestionOpts[] = [];
  let restarts = 0;
  const serverAborts: string[] = [];
  const deps: TurnRunnerDeps = {
    abortServerSide: async (id) => { serverAborts.push(id); },
    ask: async (opts) => {
      asks.push(opts);
      return overrides.ask ? overrides.ask(opts) : { text: "answer", isQuestion: false, compacted: false };
    },
    isRestarting: overrides.restarting ?? (() => false),
    waitForRestart: async () => { restarts++; },
    sessions: {
      getOrCreate: overrides.getOrCreate ?? (async () => ({ sessionId: "s1", isNew: overrides.isNew ?? false })),
      remove: (k) => { removed.push(k); },
      isCompacted: (k) => compacted.get(k) ?? false,
      setCompacted: (k, v) => { compacted.set(k, v); },
    },
    runs: {
      register: (k, r) => { runs.set(k, r); },
      get: (k) => runs.get(k),
      remove: (k) => { runs.delete(k); },
    },
    resolveScope: () => overrides.scope ?? {},
    turnCapMs: 60_000,
  };
  return { deps, runs, compacted, removed, asks, serverAborts, restarts: () => restarts, ...createTurnRunner(deps) };
}

/** Simulates a Stop that lands between registering the run and asking. */
function stopOnRegister(deps: TurnRunnerDeps) {
  const register = deps.runs.register;
  deps.runs.register = (key, run) => { run.stopRequested = true; register(key, run); };
}

describe("runTurn", () => {
  it("answers and cleans up the run", async () => {
    const t = setup();
    const s = new FakeSurface();
    const outcome = await t.runTurn(s, req({ question: "why?" }));
    assert.equal(outcome, "answered");
    assert.deepEqual(s.events, ["begin", "end", "reply"]);
    assert.deepEqual(s.replies, [{ markdown: "answer", sessionId: "s1", capped: false, failed: false }]);
    assert.equal(t.runs.size, 0);
    assert.equal(t.asks[0].question, "why?");
    assert.equal(t.asks[0].sessionId, "s1");
    assert.equal(t.asks[0].salvageOnTimeout, true);
  });

  it("forwards progress to the surface", async () => {
    const t = setup({ ask: async (opts) => { opts.onProgress?.("reading"); return { text: "a", isQuestion: false, compacted: false }; } });
    const s = new FakeSurface();
    await t.runTurn(s, req());
    assert.ok(s.events.includes("progress:reading"));
  });

  it("does nothing but tell the surface while OpenCode restarts", async () => {
    const t = setup({ restarting: () => true });
    const s = new FakeSurface();
    assert.equal(await t.runTurn(s, req()), "restarting");
    assert.deepEqual(s.events, ["restarting"]);
    assert.equal(t.asks.length, 0);
  });

  it("sends full context for new sessions and after compaction, clearing the flag", async () => {
    const fresh = setup({ isNew: true });
    await fresh.runTurn(new FakeSurface(), req());
    assert.equal(fresh.asks[0].isNewSession, true);

    const compacted = setup({ compacted: true });
    await compacted.runTurn(new FakeSurface(), req());
    assert.equal(compacted.asks[0].isNewSession, true);
    assert.equal(compacted.compacted.get("t1"), false);

    const plain = setup();
    await plain.runTurn(new FakeSurface(), req());
    assert.equal(plain.asks[0].isNewSession, false);
  });

  it("flags compaction that happens during the turn", async () => {
    const t = setup({ ask: async () => ({ text: "a", isQuestion: false, compacted: true }) });
    await t.runTurn(new FakeSurface(), req());
    assert.equal(t.compacted.get("t1"), true);
  });

  it("retires a dead session mapping but still replies", async () => {
    const t = setup({ ask: async () => ({ text: "sorry", isQuestion: false, compacted: false, failed: true, deadSession: true }) });
    const s = new FakeSurface();
    await t.runTurn(s, req());
    assert.deepEqual(t.removed, ["t1"]);
    assert.equal(s.replies[0].markdown, "sorry");
  });

  it("passes the capped flag through to the reply", async () => {
    const t = setup({ ask: async () => ({ text: "partial", isQuestion: false, compacted: false, capped: true }) });
    const s = new FakeSurface();
    await t.runTurn(s, req());
    assert.equal(s.replies[0].capped, true);
  });

  it("reports a user stop instead of an answer, and aborts again once settled", async () => {
    const s = new FakeSurface();
    const t = setup({
      ask: async (opts) => {
        // Simulates the Stop button.
        const run = t.runs.get("run1")!;
        run.stopRequested = true;
        run.controller.abort();
        assert.ok(opts.abortSignal?.aborted);
        throw new Error("Session aborted");
      },
    });
    assert.equal(await t.runTurn(s, req()), "stopped");
    assert.deepEqual(s.events, ["begin", "end", "stopped"]);
    assert.deepEqual(t.serverAborts, ["s1"]);
    assert.equal(t.runs.size, 0);
  });

  it("drops an answer that arrives after Stop", async () => {
    const s = new FakeSurface();
    const t = setup({
      ask: async () => {
        t.runs.get("run1")!.stopRequested = true;
        return { text: "late", isQuestion: false, compacted: false };
      },
    });
    assert.equal(await t.runTurn(s, req()), "stopped");
    assert.equal(s.replies.length, 0);
  });

  it("doesn't ask when the run is stopped before it starts", async () => {
    const t = setup();
    stopOnRegister(t.deps);
    assert.equal(await t.runTurn(new FakeSurface(), req()), "stopped");
    assert.equal(t.asks.length, 0);
  });

  it("keeps the full instructions owed after a failed or stopped first turn", async () => {
    const failed = setup({ isNew: true, ask: async () => { throw new Error("ECONNREFUSED"); } });
    await assert.rejects(failed.runTurn(new FakeSurface(), req()));
    assert.equal(failed.compacted.get("t1"), true);

    const stopped = setup({ isNew: true });
    stopOnRegister(stopped.deps);
    await stopped.runTurn(new FakeSurface(), req());
    assert.equal(stopped.compacted.get("t1"), true);
  });

  it("flags failed answers", async () => {
    const t = setup({ ask: async () => ({ text: "sorry", isQuestion: false, compacted: false, failed: true }) });
    const s = new FakeSurface();
    await t.runTurn(s, req());
    assert.equal(s.replies[0].failed, true);
  });

  it("rethrows an abort that wasn't a user stop", async () => {
    const t = setup({ ask: async () => { throw new Error("Session aborted"); } });
    const s = new FakeSurface();
    await assert.rejects(t.runTurn(s, req()), /Session aborted/);
    assert.deepEqual(s.events, ["begin", "end"]);
    assert.equal(t.runs.size, 0);
  });

  it("waits out a restart mid-turn and retries once with a fresh deadline", async () => {
    let calls = 0;
    let restarting = false;
    let run: ActiveRun | undefined;
    const t = setup({
      restarting: () => restarting,
      ask: async () => {
        calls++;
        if (calls === 1) {
          run = t.runs.get("run1")!;
          run.budget.deadlineAt = 0;
          restarting = true;
          throw new Error("connection reset");
        }
        restarting = false;
        return { text: "after restart", isQuestion: false, compacted: false };
      },
    });
    const s = new FakeSurface();
    const before = Date.now();
    assert.equal(await t.runTurn(s, req()), "answered");
    assert.equal(calls, 2);
    assert.equal(t.restarts(), 1);
    assert.ok(run!.budget.deadlineAt >= before + 60_000);
    assert.equal(s.replies[0].markdown, "after restart");
  });

  it("uses the scope's config unless the request overrides it", async () => {
    const scope: ScopeConfig = { agent: "build-linear", tools: ["linear"], customPrompt: "be brief" };
    const t = setup({ scope });
    await t.runTurn(new FakeSurface(), req());
    assert.equal(t.asks[0].agent, "build-linear");
    assert.deepEqual(t.asks[0].tools, ["linear"]);
    assert.equal(t.asks[0].ctx?.customPrompt, "be brief");

    const o = setup({ scope });
    await o.runTurn(new FakeSurface(), req({ agent: "custom", tools: [], context: { ...context, customPrompt: "mine" } }));
    assert.equal(o.asks[0].agent, "custom");
    assert.deepEqual(o.asks[0].tools, []);
    assert.equal(o.asks[0].ctx?.customPrompt, "mine");
  });

  it("records analytics from the surface and context", async () => {
    const t = setup();
    await t.runTurn(new FakeSurface(), req());
    assert.deepEqual(t.asks[0].analytics, { userId: "U1", channelId: "scope1", channelName: "lobby", threadKey: "t1" });
  });

  it("waits out a restart before starting when asked to", async () => {
    let restarting = true;
    const t = setup({ restarting: () => restarting });
    t.deps.waitForRestart = async () => { restarting = false; };
    const s = new FakeSurface();
    assert.equal(await t.runTurn(s, req({ waitForRestart: true })), "answered");
    assert.ok(!s.events.includes("restarting"));
  });
});

/** An ask that stays pending until the test settles it. */
function pendingAsks() {
  const waiting: { question: string; answer: (text: string) => void; fail: (err: Error) => void }[] = [];
  const ask = (opts: AskQuestionOpts) => new Promise<AskResult>((resolve, reject) => {
    waiting.push({
      question: opts.question,
      answer: (text) => resolve({ text, isQuestion: false, compacted: false }),
      fail: reject,
    });
    opts.abortSignal?.addEventListener("abort", () => reject(new Error("Session aborted")));
  });
  return { waiting, ask };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("runTurn threads", () => {
  it("runs turns in the same thread one at a time", async () => {
    const p = pendingAsks();
    const t = setup({ ask: p.ask });
    const b = new FakeSurface("t1", "b");
    const first = t.runTurn(new FakeSurface("t1", "a"), req({ question: "one" }));
    const second = t.runTurn(b, req({ question: "two" }));
    await tick();
    assert.deepEqual(p.waiting.map((w) => w.question), ["one"]);
    assert.deepEqual(b.events, ["queued"]);

    p.waiting[0].answer("first");
    assert.equal(await first, "answered");
    await tick();
    assert.deepEqual(p.waiting.map((w) => w.question), ["one", "two"]);
    p.waiting[1].answer("second");
    assert.equal(await second, "answered");
    assert.equal(b.replies[0].markdown, "second");
  });

  it("runs different threads concurrently", async () => {
    const p = pendingAsks();
    const t = setup({ ask: p.ask });
    const one = t.runTurn(new FakeSurface("t1", "a"), req());
    const two = t.runTurn(new FakeSurface("t2", "b"), req());
    await tick();
    assert.equal(p.waiting.length, 2);
    p.waiting.forEach((w) => w.answer("x"));
    await Promise.all([one, two]);
  });

  it("moves on after a turn throws", async () => {
    const p = pendingAsks();
    const t = setup({ ask: p.ask });
    const first = t.runTurn(new FakeSurface("t1", "a"), req());
    const second = t.runTurn(new FakeSurface("t1", "b"), req());
    await tick();
    p.waiting[0].fail(new Error("boom"));
    await assert.rejects(first, /boom/);
    await tick();
    p.waiting[1].answer("ok");
    assert.equal(await second, "answered");
  });

  it("stopThread stops the running turn and drops the queued ones", async () => {
    const p = pendingAsks();
    const t = setup({ ask: p.ask });
    const b = new FakeSurface("t1", "b");
    const first = t.runTurn(new FakeSurface("t1", "a"), req());
    const second = t.runTurn(b, req());
    await tick();
    assert.equal(t.stopThread("t1"), true);
    assert.equal(await first, "stopped");
    assert.equal(await second, "stopped");
    assert.equal(p.waiting.length, 1);
    assert.deepEqual(b.events, ["queued", "stopped"]);
    assert.ok(t.serverAborts.length > 0);

    assert.equal(t.stopThread("t1"), false);
  });

  it("stopThread during session lookup prevents the ask", async () => {
    let resolveSession!: () => void;
    const t = setup({
      getOrCreate: () => new Promise((r) => { resolveSession = () => r({ sessionId: "s1", isNew: false }); }),
    });
    const turn = t.runTurn(new FakeSurface(), req());
    await tick();
    assert.equal(t.stopThread("t1"), true);
    resolveSession();
    assert.equal(await turn, "stopped");
    assert.equal(t.asks.length, 0);
  });
});
