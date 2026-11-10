/** Surface-agnostic Q&A turn lifecycle. Deps are injected for testing; src/surfaces/slack.ts wires the real ones. */
import type { AskQuestionOpts, AskResult } from "./opencode.js";
import type { ActiveRun } from "./run-registry.js";
import type { Surface } from "./surfaces/types.js";
import type { ConversationContext } from "./conversation-context.js";
import type { ConvertedFile } from "./attachments.js";
import type { RepoInfo } from "./context-prefix.js";
import type { ScopeConfig } from "./scope-config.js";

export interface TurnRunnerDeps {
  ask: (opts: AskQuestionOpts) => Promise<AskResult>;
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
  resolveScope: (scopeId: string) => ScopeConfig;
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
}

export type TurnOutcome = "answered" | "stopped" | "restarting";

export function createTurnRunner(deps: TurnRunnerDeps) {
  return async function runTurn(surface: Surface, request: TurnRequest): Promise<TurnOutcome> {
    if (deps.isRestarting()) {
      await surface.restarting?.();
      return "restarting";
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
    surface.begin?.();

    const scope = deps.resolveScope(surface.scopeId);
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

    let result: AskResult;
    try {
      try {
        result = await deps.ask(askOpts);
      } catch (err) {
        // User pressed Stop: the abort already reached the server; just confirm.
        if (deps.runs.get(runKey)?.stopRequested && err instanceof Error && err.message === "Session aborted") {
          await surface.stopped?.();
          return "stopped";
        }
        // If the server is restarting (tool config change killed it mid-flight),
        // wait for the restart to finish and retry once.
        if (!deps.isRestarting()) throw err;
        surface.progress?.("_Reconfiguring... I'll pick back up in a moment._");
        await deps.waitForRestart();
        budget.deadlineAt = Date.now() + deps.turnCapMs;
        result = await deps.ask(askOpts);
      }
    } finally {
      deps.runs.remove(runKey);
      await surface.end?.();
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

    await surface.reply(result.text, { sessionId, capped: !!result.capped });
    return "answered";
  };
}

export type RunTurn = ReturnType<typeof createTurnRunner>;
