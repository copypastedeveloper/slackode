import { createOpencodeClient, type Event, type OpencodeClient } from "@opencode-ai/sdk";
import { autoAllowPermission } from "./opencode.js";

export type ProgressCallback = (text: string) => void;

/**
 * Open a fresh SSE subscription against an OpenCode server. Returned to the caller
 * so they can subscribe BEFORE calling promptAsync — otherwise the first events
 * (message.updated role=user, first step-start) can fire before the subscription
 * lands and get dropped.
 */
export async function openStream(baseUrl: string): Promise<{
  sseClient: OpencodeClient;
  stream: AsyncIterableIterator<Event> & { return: (value?: unknown) => Promise<IteratorResult<Event>> };
}> {
  const sseClient = createOpencodeClient({ baseUrl });
  const subscription = await sseClient.event.subscribe();
  return { sseClient, stream: subscription.stream };
}

export interface StreamAnswerOpts {
  /** OpenCode session ID to listen for. */
  sessionId: string;
  /** Pre-opened SSE client + event iterator from openStream(). */
  sseClient: OpencodeClient;
  stream: AsyncIterableIterator<Event> & { return: (value?: unknown) => Promise<IteratorResult<Event>> };
  /** Optional progress callback fired as text/tool updates arrive. */
  onProgress?: ProgressCallback;
  /** Optional abort signal — when fired, the stream terminates and throws "Session aborted". */
  abortSignal?: AbortSignal;
  /**
   * Optional mutable deadline. When Date.now() passes budget.deadlineAt the turn
   * terminates with reason "timeout". The caller may push deadlineAt later while
   * the turn runs (the "keep waiting" button). Defaults to start + 10 minutes.
   */
  budget?: { deadlineAt: number };
}

/** Snapshot of everything the streaming loop observed, used by analytics + the empty-answer debug log. */
export interface StreamDiag {
  durationMs: number;
  partCounts: Record<string, number>;
  stepStarts: number;
  stepFinishReasons: string[];
  toolsRunning: number;
  toolsCompleted: number;
  toolsErrored: number;
  compactions: number;
  textPartsAcceptedForActiveMessage: number;
  textPartsRejectedNoActiveMessage: number;
  textPartsRejectedMessageIdMismatch: number;
  sessionIdleReceived: boolean;
  timeoutFired: boolean;
  terminateReason: "" | "timeout" | "idle";
  abortReceived: boolean;
  lastAssistantMessageId: string | null;
  answerCaptured: boolean;
  skipNextStop: boolean;
}

/** Summed token counts + cost across all step-finish events in this turn. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface StreamResult {
  /** Assistant text accepted from the stream. Empty string if the model produced nothing. */
  text: string;
  /** True if a compaction event was observed during this stream. */
  compacted: boolean;
  /** Diagnostic counters — emitted by askQuestion when it falls through to the empty-answer branch. */
  diag: StreamDiag;
  /** Tools the agent actually invoked, with call counts. */
  toolsUsed: Array<{ name: string; calls: number }>;
  /** Skills the agent activated (extracted best-effort from `skill` tool inputs). */
  skillsUsed: string[];
  /** Summed usage across step-finish events. Zero on providers/versions that don't report it. */
  usage: UsageTotals;
}

function getToolStateType(part: { state?: unknown }): string | undefined {
  return part.state && typeof part.state === "object" && "type" in part.state
    ? (part.state as { type: string }).type
    : undefined;
}

/**
 * Best-effort extraction of the skill name from a `skill` tool part's input.
 * The opencode SDK's `Part` discriminated union doesn't expose a typed shape for
 * tool inputs; cast tightly and tolerate misses (just return undefined).
 */
function extractSkillName(part: unknown): string | undefined {
  const input = (part as { state?: { input?: { name?: string; skill?: string } } }).state?.input;
  return input?.name ?? input?.skill;
}

/**
 * Run the SSE streaming loop against an OpenCode session.
 *
 * Owns:
 * - Subscribing to events on a fresh client (so promptAsync errors don't poison this subscription).
 * - Filtering parts to this session ID.
 * - Distinguishing the user's echoed prompt (rejected) from assistant text (accepted) via
 *   message.updated `role` events plus a first-text-part fallback.
 * - A hard 10-minute exchange ceiling AND a 90-second idle watchdog that actively closes the
 *   stream — a true hang produces zero events, so the `for await` would otherwise block forever
 *   on `stream.next()` and never re-check `done`.
 * - Tracking tools and skills the agent invoked for downstream analytics.
 *
 * Returns even on abort/watchdog/idle — caller decides how to surface that.
 * Throws ONLY when abortSignal fires (matching the prior askQuestion contract).
 */
export async function streamAnswer(opts: StreamAnswerOpts): Promise<StreamResult> {
  const { sessionId, sseClient, stream, onProgress, abortSignal } = opts;

  let latestText = "";
  const activeTools: Map<string, string> = new Map();
  const toolCallCounts: Map<string, number> = new Map();
  const skillsActivated: Set<string> = new Set();
  const usage: UsageTotals = {
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0,
  };
  let done = false;
  let answerCaptured = false;
  let compacted = false;
  let skipNextStop = false;
  let assistantMessageId: string | undefined;
  let userMessageId: string | undefined;

  const streamStartMs = Date.now();
  const diag: StreamDiag = {
    durationMs: 0,
    partCounts: {},
    stepStarts: 0,
    stepFinishReasons: [],
    toolsRunning: 0,
    toolsCompleted: 0,
    toolsErrored: 0,
    compactions: 0,
    textPartsAcceptedForActiveMessage: 0,
    textPartsRejectedNoActiveMessage: 0,
    textPartsRejectedMessageIdMismatch: 0,
    sessionIdleReceived: false,
    timeoutFired: false,
    terminateReason: "",
    abortReceived: false,
    lastAssistantMessageId: null,
    answerCaptured: false,
    skipNextStop: false,
  };
  const bumpPart = (t: string): void => { diag.partCounts[t] = (diag.partCounts[t] ?? 0) + 1; };

  const TIMEOUT_MS = 10 * 60 * 1000;
  const IDLE_MS = 90 * 1000;

  const terminate = (reason: "timeout" | "idle"): void => {
    done = true;
    diag.timeoutFired = true;
    diag.terminateReason = reason;
    try { void stream.return(undefined); } catch { /* already closed */ }
  };

  // Deadline is polled (not a one-shot timer) so the caller can extend
  // budget.deadlineAt mid-turn ("keep waiting" button).
  const budget = opts.budget ?? { deadlineAt: streamStartMs + TIMEOUT_MS };
  const deadlineTimer = setInterval(() => {
    if (Date.now() >= budget.deadlineAt) terminate("timeout");
  }, 5_000);
  let idleTimer: ReturnType<typeof setTimeout> = setTimeout(() => terminate("idle"), IDLE_MS);
  const resetIdle = (): void => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => terminate("idle"), IDLE_MS);
  };
  let postAnswerTimeout: ReturnType<typeof setTimeout> | undefined;

  try {
    for await (const event of stream) {
      resetIdle();
      if (done) break;
      if (abortSignal?.aborted) {
        console.log(`[opencode] Session ${sessionId} aborted — exiting SSE loop.`);
        break;
      }

      const evt = event as Event;

      if (evt.type === "message.updated") {
        const info = (evt.properties as { info?: { sessionID?: string; role?: string; id?: string } }).info;
        if (info?.sessionID !== sessionId) continue;
        if (info.role === "user" && info.id) userMessageId = info.id;
        else if (info.role === "assistant" && info.id) assistantMessageId = info.id;
      } else if (evt.type === "message.part.updated") {
        const { part } = evt.properties;
        if (part.sessionID !== sessionId) continue;
        bumpPart(part.type);

        if (answerCaptured) {
          if (part.type === "compaction") {
            compacted = true;
            diag.compactions++;
            done = true;
            break;
          }
          continue;
        }

        if (part.type === "step-start") {
          assistantMessageId = (part as { messageID?: string }).messageID;
          diag.stepStarts++;
        } else if (part.type === "text") {
          const partMessageId = (part as { messageID?: string }).messageID;
          if (!userMessageId) {
            userMessageId = partMessageId;
            diag.textPartsRejectedNoActiveMessage++;
            continue;
          }
          if (partMessageId === userMessageId) {
            diag.textPartsRejectedNoActiveMessage++;
            continue;
          }
          diag.textPartsAcceptedForActiveMessage++;
          if (!assistantMessageId) assistantMessageId = partMessageId;
          latestText = part.text ?? "";
          if (onProgress && latestText) onProgress(latestText);
        } else if (part.type === "tool") {
          const stateType = getToolStateType(part);
          if (stateType === "running") {
            diag.toolsRunning++;
            activeTools.set(part.callID, part.tool);
            toolCallCounts.set(part.tool, (toolCallCounts.get(part.tool) ?? 0) + 1);
            if (part.tool === "skill") {
              const skillName = extractSkillName(part);
              if (skillName) skillsActivated.add(skillName);
            }
            if (onProgress) {
              const toolNames = [...activeTools.values()].join(", ");
              onProgress(latestText
                ? `${latestText}\n\n_Using: ${toolNames}..._`
                : `_Using: ${toolNames}..._`);
            }
          } else if (stateType === "completed" || stateType === "error") {
            if (stateType === "completed") diag.toolsCompleted++;
            else diag.toolsErrored++;
            activeTools.delete(part.callID);
          }
        } else if (part.type === "compaction") {
          console.log(`[opencode] Compaction event for session ${sessionId}`);
          compacted = true;
          diag.compactions++;
          skipNextStop = true;
          assistantMessageId = undefined;
          latestText = "";
          activeTools.clear();
        } else if (part.type === "step-finish") {
          const reason = (part as { reason?: string }).reason;
          diag.stepFinishReasons.push(reason ?? "(none)");
          // Accumulate cost + tokens from this step. Best-effort: some providers/versions
          // omit these fields; missing values stay at 0 in the totals.
          const usagePart = part as {
            cost?: number;
            tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
          };
          if (typeof usagePart.cost === "number") usage.costUsd += usagePart.cost;
          if (usagePart.tokens) {
            usage.inputTokens += usagePart.tokens.input ?? 0;
            usage.outputTokens += usagePart.tokens.output ?? 0;
            usage.reasoningTokens += usagePart.tokens.reasoning ?? 0;
            usage.cacheReadTokens += usagePart.tokens.cache?.read ?? 0;
            usage.cacheWriteTokens += usagePart.tokens.cache?.write ?? 0;
          }
          if (reason === "stop") {
            if (skipNextStop) {
              console.log(`[opencode] Skipping post-compaction auto-continue stop for session ${sessionId}`);
              skipNextStop = false;
              assistantMessageId = undefined;
              latestText = "";
              continue;
            }
            answerCaptured = true;
            postAnswerTimeout = setTimeout(() => { done = true; }, 30_000);
          } else if (reason === "tool-calls" && skipNextStop) {
            skipNextStop = false;
          }
        }
      } else if (evt.type === "permission.updated") {
        const perm = evt.properties;
        if (perm.sessionID === sessionId) {
          await autoAllowPermission(sseClient, sessionId, perm, "opencode");
        }
      } else if (evt.type === "session.idle") {
        if (evt.properties.sessionID === sessionId) {
          diag.sessionIdleReceived = true;
          done = true;
          break;
        }
      }
    }
  } finally {
    clearInterval(deadlineTimer);
    clearTimeout(idleTimer);
    if (postAnswerTimeout) clearTimeout(postAnswerTimeout);
    stream.return(undefined);
  }

  diag.durationMs = Date.now() - streamStartMs;
  diag.lastAssistantMessageId = assistantMessageId ?? null;
  diag.answerCaptured = answerCaptured;
  diag.skipNextStop = skipNextStop;

  if (abortSignal?.aborted) {
    diag.abortReceived = true;
    throw new Error("Session aborted");
  }

  const toolsUsed = [...toolCallCounts.entries()]
    .map(([name, calls]) => ({ name, calls }))
    .sort((a, b) => b.calls - a.calls);

  return {
    text: latestText,
    compacted,
    diag,
    toolsUsed,
    skillsUsed: [...skillsActivated],
    usage,
  };
}
