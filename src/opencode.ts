import {
  createOpencodeClient,
  type OpencodeClient,
} from "@opencode-ai/sdk";
import { buildPrefix } from "./context-prefix.js";
import type { RepoInfo } from "./context-prefix.js";
import type { SlackContext } from "./utils/slack-context.js";
import type { ConvertedFile } from "./utils/slack-files.js";
import { REQUEST_TIMEOUT_MS } from "./constants.js";
import { openStream, streamAnswer } from "./opencode-stream.js";
import { recordTurn, type TurnOutcome } from "./db/turns.js";

let client: OpencodeClient;
let baseUrl: string;

export function initOpencode(url: string): void {
  baseUrl = url;
  client = createOpencodeClient({
    baseUrl,
    fetch: (request: Request) =>
      globalThis.fetch(request, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
  });
}

export function getClient(): OpencodeClient {
  if (!client) {
    throw new Error("OpenCode client not initialized. Call initOpencode() first.");
  }
  return client;
}

export function getBaseUrl(): string {
  if (!baseUrl) {
    throw new Error("OpenCode client not initialized. Call initOpencode() first.");
  }
  return baseUrl;
}

/**
 * Auto-allow a permission prompt so the session doesn't hang.
 * Shared by Q&A, context-gen, and coding session SSE loops.
 */
export async function autoAllowPermission(
  sseClient: OpencodeClient,
  sessionId: string,
  perm: { id: string; type?: string; pattern?: unknown; title?: string },
  label: string,
): Promise<void> {
  console.warn(
    `[${label}] Permission prompt blocked session ${sessionId}: ` +
    `type=${perm.type} pattern=${JSON.stringify(perm.pattern)}${perm.title ? ` title="${perm.title}"` : ""} — auto-allowing`,
  );
  try {
    await sseClient.postSessionIdPermissionsPermissionId({
      path: { id: sessionId, permissionID: perm.id },
      body: { response: "once" },
    });
  } catch (err) {
    console.error(`[${label}] Failed to auto-allow permission ${perm.id}:`, err);
  }
}

export async function createSession(title: string, directory?: string): Promise<string> {
  const result = await getClient().session.create({
    body: { title },
    ...(directory ? { query: { directory } } : {}),
  });

  if (!result.data) {
    throw new Error(`Failed to create session: ${JSON.stringify(result.error)}`);
  }

  return result.data.id;
}

// ── Context prefix thin wrappers ──

export function buildContextPrefix(
  ctx: SlackContext,
  isNew: boolean,
  tools?: string[],
  repo?: RepoInfo,
): string {
  return buildPrefix({ ctx, isNew, mode: "qa", tools, repo });
}

export function buildCodingContextPrefix(
  ctx: SlackContext,
  isNew: boolean,
  repoName: string,
  repoDir: string,
): string {
  return buildPrefix({ ctx, isNew, mode: "coding", repoName, repoDir });
}

export function buildPlanningContextPrefix(
  ctx: SlackContext,
  isNew: boolean,
  repoName: string,
  repoDir: string,
): string {
  return buildPrefix({ ctx, isNew, mode: "planning", repoName, repoDir });
}

// ── Shorter response + enrichment ──

/**
 * Ask the same session/agent to restate its last response more briefly.
 * Used when the original response triggers Slack's msg_too_long error.
 */
export async function askForShorterResponse(
  opts: Pick<AskQuestionOpts, "sessionId" | "customClient" | "customBaseUrl">,
): Promise<string> {
  try {
    const result = await askQuestion({
      ...opts,
      question: "Your last response was too long for Slack. Restate it in under 3000 characters. " +
        "List only the files changed with a one-line description each. " +
        "No code snippets, no diffs, no detailed explanations.",
      isNewSession: false,
    });
    if (result.text.trim()) return result.text.trim();
  } catch (err) {
    console.warn("[shorten] Failed to get shorter response, falling back to truncation:", err);
  }
  return "(Response too long for Slack — use `status` to see changes, or `pr` to create a PR with the full diff.)";
}

/**
 * Use the Q&A server's `enrich` agent (MCP tools only) to look up
 * external context (Linear tickets, Sentry issues, URLs) referenced
 * in a coding task description. Returns the description with any
 * fetched context prepended.
 */
export async function enrichContextForCoding(description: string): Promise<string> {
  const hasReference = /[A-Z]+-\d+|linear|sentry|jira|github\.com\/.*\/(issues|pull)|https?:\/\//i.test(description);
  if (!hasReference) return description;

  console.log("[enrich] Enriching context for coding session...");
  const start = Date.now();

  const ENRICH_TIMEOUT_MS = 30_000;

  const enrichment = (async () => {
    const sessionId = await createSession("context-enrichment");
    const result = await askQuestion({
      sessionId,
      question:
        "Look up the referenced tickets, issues, or URLs below using your tools. " +
        "Return the raw details (title, description, acceptance criteria, error info). " +
        "Do NOT analyze, summarize, or suggest solutions. Just fetch and return the data.\n\n" +
        description,
      isNewSession: true,
      agent: "enrich",
    });
    return result.text.trim();
  })();

  const timeout = new Promise<string>((resolve) =>
    setTimeout(() => {
      console.warn(`[enrich] Timed out after ${ENRICH_TIMEOUT_MS / 1000}s, proceeding without enrichment`);
      resolve("");
    }, ENRICH_TIMEOUT_MS),
  );

  try {
    const enrichedText = await Promise.race([enrichment, timeout]);
    if (enrichedText) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[enrich] Context enriched successfully (${elapsed}s)`);
      return `<enriched_context>\n${enrichedText}\n</enriched_context>\n\n${description}`;
    }
  } catch (err) {
    console.warn("[enrich] Failed to enrich context:", err);
  }

  return description;
}

// ── askQuestion: SSE streaming pipeline ──

export type ProgressCallback = (status: string) => void;

export interface AskResult {
  text: string;
  isQuestion: boolean;
  compacted: boolean;
}

export interface AskQuestionOpts {
  sessionId: string;
  question: string;
  ctx?: SlackContext;
  onProgress?: ProgressCallback;
  isNewSession?: boolean;
  agent?: string;
  tools?: string[];
  files?: ConvertedFile[];
  repo?: RepoInfo;
  customClient?: OpencodeClient;
  customBaseUrl?: string;
  customContextPrefix?: string;
  abortSignal?: AbortSignal;
  /** Analytics context — when supplied, the turn is recorded to the `turns` table. */
  analytics?: {
    userId: string;
    channelId: string;
    channelName?: string;
    threadKey?: string;
  };
}

export async function askQuestion(opts: AskQuestionOpts): Promise<AskResult> {
  const {
    sessionId, question, ctx, onProgress, isNewSession, agent, tools, files, repo,
    customClient, customBaseUrl, customContextPrefix, abortSignal, analytics,
  } = opts;

  const activeClient = customClient ?? getClient();
  const activeBaseUrl = customBaseUrl ?? baseUrl;

  const contextPrefix = customContextPrefix
    ?? (ctx ? buildContextPrefix(ctx, isNewSession ?? false, tools, repo) : "");

  const wrappedQuestion = `<user_question>\n${question}\n</user_question>`;

  const parts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string }> = [
    { type: "text", text: contextPrefix + wrappedQuestion },
  ];
  if (files && files.length > 0) {
    for (const f of files) {
      parts.push({ type: "file", mime: f.mime, url: f.dataUri, filename: f.filename });
    }
  }

  // Open the SSE subscription BEFORE promptAsync — otherwise the first events
  // (user message creation, first step-start) can fire before we're listening.
  const { sseClient, stream: eventStream } = await openStream(activeBaseUrl);

  await activeClient.session.promptAsync({
    path: { id: sessionId },
    body: {
      ...(agent ? { agent } : {}),
      parts,
    },
  });

  let stream: Awaited<ReturnType<typeof streamAnswer>>;
  try {
    stream = await streamAnswer({
      sessionId,
      sseClient,
      stream: eventStream,
      onProgress,
      abortSignal,
    });
  } catch (err) {
    // streamAnswer throws only on abortSignal — record the turn as aborted, then re-raise.
    if (err instanceof Error && err.message === "Session aborted") {
      recordTurnIfRequested(analytics, {
        outcome: "aborted",
        question,
        agent,
        repoName: repo?.name,
        toolsEnabled: tools,
        sessionId,
      });
    }
    throw err;
  }

  const baseTurn = {
    question,
    agent,
    repoName: repo?.name,
    toolsEnabled: tools,
    sessionId,
    toolsUsed: stream.toolsUsed,
    skillsUsed: stream.skillsUsed,
    durationMs: stream.diag.durationMs,
    stepCount: stream.diag.stepStarts,
    compacted: stream.compacted,
  };

  // Watchdog bail-out: opencode went silent (no events) or hit the hard ceiling.
  if (!stream.text && stream.diag.terminateReason) {
    console.warn("[opencode] aborted on watchdog", JSON.stringify({
      sessionId,
      reason: stream.diag.terminateReason,
      ...stream.diag,
    }));
    recordTurnIfRequested(analytics, {
      ...baseTurn,
      outcome: stream.diag.terminateReason === "timeout" ? "timeout" : "error",
      outcomeDetail: `watchdog: ${stream.diag.terminateReason}`,
    });
    return {
      text: "Sorry — that took too long and I had to give up (the assistant backend stopped responding). Please try again.",
      isQuestion: false,
      compacted: false,
    };
  }

  // No assistant text — model genuinely produced nothing.
  if (!stream.text) {
    console.warn("[opencode] empty answer", JSON.stringify({ sessionId, ...stream.diag }));
    recordTurnIfRequested(analytics, { ...baseTurn, outcome: "empty" });
    return { text: "I wasn't able to generate a response. Please try again.", isQuestion: false, compacted: false };
  }

  recordTurnIfRequested(analytics, {
    ...baseTurn,
    outcome: "success",
    responseChars: stream.text.length,
  });

  const trimmed = stream.text.trim();
  const isQuestion = trimmed.endsWith("?");
  return { text: stream.text, isQuestion, compacted: stream.compacted };
}

interface TurnRecordingInput {
  question: string;
  agent?: string;
  repoName?: string;
  toolsEnabled?: string[];
  sessionId?: string;
  toolsUsed?: Array<{ name: string; calls: number }>;
  skillsUsed?: string[];
  durationMs?: number;
  stepCount?: number;
  responseChars?: number;
  compacted?: boolean;
  outcome: TurnOutcome;
  outcomeDetail?: string;
}

/**
 * Persist one turn to the `turns` table if the caller passed analytics context.
 * Swallows all errors — analytics must never fail the user-visible response.
 */
function recordTurnIfRequested(
  analytics: AskQuestionOpts["analytics"],
  input: TurnRecordingInput,
): void {
  if (!analytics) return;
  recordTurn({
    userId: analytics.userId,
    channelId: analytics.channelId,
    channelName: analytics.channelName,
    threadKey: analytics.threadKey,
    sessionId: input.sessionId,
    agent: input.agent,
    repoName: input.repoName,
    toolsEnabled: input.toolsEnabled,
    toolsUsed: input.toolsUsed,
    skillsUsed: input.skillsUsed,
    questionChars: input.question.length,
    responseChars: input.responseChars,
    durationMs: input.durationMs,
    stepCount: input.stepCount,
    outcome: input.outcome,
    outcomeDetail: input.outcomeDetail,
    compacted: input.compacted,
  });
}
