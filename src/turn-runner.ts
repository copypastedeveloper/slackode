/** Surface-agnostic Q&A turn lifecycle. Deps are injected for testing; src/surfaces/run-turn.ts wires the real ones. */
import type { AskQuestionOpts, AskResult } from "./opencode.js";
import { requestStop, type ActiveRun } from "./run-registry.js";
import type { Surface } from "./surfaces/types.js";
import type { ConversationContext } from "./conversation-context.js";
import type { ConvertedFile } from "./attachments.js";
import type { RepoInfo } from "./context-prefix.js";
import type { ScopeConfig } from "./scope-config.js";

export interface TurnRunnerDeps {
  ask: (opts: AskQuestionOpts) => Promise<AskResult>;
  abortServerSide: (sessionId: string) => Promise<void>;
  isRestarting: () => boolean;
  waitForRestart: () => Promise<void>;
  sessions: {
    getOrCreate: (threadKey: string, scopeId: string) => Promise<{ sessionId: string; isNew: boolean }>;
    remove: (threadKey: string) => void;
    isCompacted: (threadKey: string) => boolean;
    setCompacted: (threadKey: string, compacted: boolean) => void;
  };
  runs: {
    register: (key: string, run: ActiveRun) => void;
    get: (key: string) => ActiveRun | undefined;
    remove: (key: string) => void;
  };
  resolveScope: (surfaceId: string, scopeId: string) => ScopeConfig;
  turnCapMs: number;
}

/** The runner adds the session, run controls, scope config and analytics. */
export interface TurnRequest {
  question: string;
  context: ConversationContext;
  files?: ConvertedFile[];
  // Overrides for the scope's configured values.
  agent?: string;
  tools?: string[];
  repo?: RepoInfo;
  /** Wait out an OpenCode restart instead of returning "restarting". */
  waitForRestart?: boolean;
}

export type TurnOutcome = "answered" | "stopped" | "restarting";

/** Turns in one thread share an OpenCode session, so they run one at a time. */
interface Thread {
  /** Settles when the last queued turn finishes. */
  tail: Promise<void>;
  pending: number;
  /** Bumped by stopThread; queued turns from an older generation are dropped. */
  generation: number;
  runKey?: string;
}

export function createTurnRunner(deps: TurnRunnerDeps) {
  const threads = new Map<string, Thread>();

  const stop = (run: ActiveRun) => requestStop(run, deps.abortServerSide);

  async function runTurn(surface: Surface, request: TurnRequest): Promise<TurnOutcome> {
    let t = threads.get(surface.threadKey);
    if (!t) threads.set(surface.threadKey, t = { tail: Promise.resolve(), pending: 0, generation: 0 });
    const generation = t.generation;
    const ahead = t.tail;
    let release!: () => void;
    t.tail = new Promise((resolve) => { release = resolve; });
    t.pending++;
    try {
      if (t.pending > 1) {
        await surface.queued?.().catch((err) => console.warn(`[turn] ${surface.kind} queued notice failed:`, err));
      }
      await ahead;
      if (generation !== t.generation) {
        await surface.stopped?.();
        return "stopped";
      }
      return await runNext(surface, request, t, generation);
    } finally {
      t.runKey = undefined;
      release();
      if (--t.pending === 0) threads.delete(surface.threadKey);
    }
  }

  /** Drop the thread's queued turns and stop its running one. Returns false if nothing was pending. */
  function stopThread(threadKey: string): boolean {
    const t = threads.get(threadKey);
    if (!t) return false;
    t.generation++;
    const run = t.runKey ? deps.runs.get(t.runKey) : undefined;
    if (run) stop(run);
    return true;
  }

  async function runNext(surface: Surface, request: TurnRequest, t: Thread, generation: number): Promise<TurnOutcome> {
    while (deps.isRestarting()) {
      if (!request.waitForRestart) {
        await surface.restarting?.();
        return "restarting";
      }
      await deps.waitForRestart();
    }

    const { threadKey, runKey } = surface;
    const { sessionId, isNew } = await deps.sessions.getOrCreate(threadKey, surface.scopeId);

    // If a previous response triggered compaction, re-send full instructions
    // so the agent recovers its behavioral constraints, then clear the flag.
    const needsFullContext = isNew || deps.sessions.isCompacted(threadKey);
    if (!isNew && needsFullContext) {
      deps.sessions.setCompacted(threadKey, false);
    }

    // Long-run controls: a mutable deadline that "keep waiting" can extend and
    // an abort controller that Stop fires, both reachable via the run registry.
    const controller = new AbortController();
    const budget = { deadlineAt: Date.now() + deps.turnCapMs };
    const run: ActiveRun = { sessionId, controller, budget, stopRequested: false, extensions: 0 };
    deps.runs.register(runKey, run);
    t.runKey = runKey;
    // A stopThread that landed while the session resolved found no run to stop.
    if (generation !== t.generation) stop(run);
    surface.begin?.();

    const scope = deps.resolveScope(surface.kind, surface.scopeId);
    const context: ConversationContext = {
      ...request.context,
      customPrompt: request.context.customPrompt ?? scope.customPrompt,
    };
    const askOpts: AskQuestionOpts = {
      question: request.question,
      ctx: context,
      files: request.files,
      agent: request.agent ?? scope.agent,
      tools: request.tools ?? scope.tools,
      repo: request.repo ?? scope.repo,
      analytics: {
        userId: context.requester.id,
        channelId: surface.scopeId,
        channelName: context.place.name,
        threadKey,
      },
      sessionId,
      isNewSession: needsFullContext,
      onProgress: (status) => surface.progress?.(status),
      abortSignal: controller.signal,
      budget,
      salvageOnTimeout: true,
    };

    let result: AskResult | undefined;
    try {
      if (!run.stopRequested) {
        try {
          result = await deps.ask(askOpts);
        } catch (err) {
          const aborted = err instanceof Error && err.message === "Session aborted";
          if (!(run.stopRequested && aborted)) {
            // If the server is restarting (tool config change killed it mid-flight),
            // wait for the restart to finish and retry once.
            if (!deps.isRestarting()) throw err;
            surface.progress?.("_Reconfiguring... I'll pick back up in a moment._");
            await deps.waitForRestart();
            budget.deadlineAt = Date.now() + deps.turnCapMs;
            result = await deps.ask(askOpts);
          }
        }
      }
    } finally {
      deps.runs.remove(runKey);
      // A turn that didn't answer still owes the full instructions to the next one.
      if (needsFullContext && (!result || run.stopRequested)) {
        deps.sessions.setCompacted(threadKey, true);
      }
      if (run.stopRequested) {
        // The prompt can reach the server after Stop's abort (e.g. while the
        // stream was opening), so abort again before the next turn can start.
        await run.serverAbort;
        await deps.abortServerSide(sessionId).catch(() => {});
      }
      await surface.end?.();
    }

    if (run.stopRequested || !result) {
      await surface.stopped?.();
      return "stopped";
    }

    // Wedged session (never started the turn): retire the thread mapping so the
    // next question gets a fresh session instead of piling up behind the zombie.
    if (result.deadSession) {
      deps.sessions.remove(threadKey);
      console.warn(`[run-control] Retired wedged session mapping for ${surface.kind} thread ${threadKey} (session ${sessionId})`);
    }

    // If compaction occurred during this response, flag the session so the
    // next message re-sends the full behavioral instructions.
    if (result.compacted) {
      deps.sessions.setCompacted(threadKey, true);
    }

    await surface.reply(result.text, { sessionId, capped: !!result.capped, failed: !!result.failed });
    return "answered";
  }

  return { runTurn, stopThread };
}

export type TurnRunner = ReturnType<typeof createTurnRunner>;
export type RunTurn = TurnRunner["runTurn"];
