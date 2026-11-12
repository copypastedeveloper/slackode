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
  readonly threadKey = "t1";
  readonly scopeId = "scope1";
  readonly runKey = "run1";
  events: string[] = [];
  replies: { markdown: string; sessionId: string; capped: boolean }[] = [];

  async restarting() { this.events.push("restarting"); }
  progress(status: string) { this.events.push(`progress:${status}`); }
  begin() { this.events.push("begin"); }
  async end() { this.events.push("end"); }
  async stopped() { this.events.push("stopped"); }
  async reply(markdown: string, meta: { sessionId: string; capped: boolean }) {
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
} = {}) {
  const runs = new Map<string, ActiveRun>();
  const compacted = new Map<string, boolean>([["t1", overrides.compacted ?? false]]);
  const removed: string[] = [];
  const asks: AskQuestionOpts[] = [];
  let restarts = 0;
  const deps: TurnRunnerDeps = {
    ask: async (opts) => {
      asks.push(opts);
      return overrides.ask ? overrides.ask(opts) : { text: "answer", isQuestion: false, compacted: false };
    },
    isRestarting: overrides.restarting ?? (() => false),
    waitForRestart: async () => { restarts++; },
    sessions: {
      getOrCreate: async () => ({ sessionId: "s1", isNew: overrides.isNew ?? false }),
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
  return { deps, runs, compacted, removed, asks, restarts: () => restarts, runTurn: createTurnRunner(deps) };
}

describe("runTurn", () => {
  it("answers and cleans up the run", async () => {
    const t = setup();
    const s = new FakeSurface();
    const outcome = await t.runTurn(s, req({ question: "why?" }));
    assert.equal(outcome, "answered");
    assert.deepEqual(s.events, ["begin", "end", "reply"]);
    assert.deepEqual(s.replies, [{ markdown: "answer", sessionId: "s1", capped: false }]);
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

  it("reports a user stop instead of an answer", async () => {
    const s = new FakeSurface();
    const t = setup({
      ask: async (opts) => {
        // Simulates the Stop button: flag the registered run, then abort.
        const run = t.runs.get("run1")!;
        run.stopRequested = true;
        run.controller.abort();
        assert.ok(opts.abortSignal?.aborted);
        throw new Error("Session aborted");
      },
    });
    assert.equal(await t.runTurn(s, req()), "stopped");
    assert.deepEqual(s.events, ["begin", "stopped", "end"]);
    assert.equal(t.runs.size, 0);
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
});
