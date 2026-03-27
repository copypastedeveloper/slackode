import {
  createOpencodeClient,
  type OpencodeClient,
  type Event,
} from "@opencode-ai/sdk";
import { buildPrefix } from "./context-prefix.js";
import type { RepoInfo } from "./context-prefix.js";
import type { SlackContext } from "./utils/slack-context.js";
import type { ConvertedFile } from "./utils/slack-files.js";
import { REQUEST_TIMEOUT_MS } from "./constants.js";

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
}

function getToolStateType(part: { state?: unknown }): string | undefined {
  return part.state && typeof part.state === "object" && "type" in part.state
    ? (part.state as { type: string }).type
    : undefined;
}

export async function askQuestion(opts: AskQuestionOpts): Promise<AskResult> {
  const {
    sessionId, question, ctx, onProgress, isNewSession, agent, tools, files, repo,
    customClient, customBaseUrl, customContextPrefix, abortSignal,
  } = opts;

  const activeClient = customClient ?? getClient();
  const activeBaseUrl = customBaseUrl ?? baseUrl;

  const contextPrefix = customContextPrefix
    ?? (ctx ? buildContextPrefix(ctx, isNewSession ?? false, tools, repo) : "");

  const wrappedQuestion = `<user_question>\n${question}\n</user_question>`;

  const sseClient = createOpencodeClient({ baseUrl: activeBaseUrl });
  const subscription = await sseClient.event.subscribe();
  const stream = subscription.stream;

  const parts: Array<{ type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string }> = [
    { type: "text", text: contextPrefix + wrappedQuestion },
  ];
  if (files && files.length > 0) {
    for (const f of files) {
      parts.push({ type: "file", mime: f.mime, url: f.dataUri, filename: f.filename });
    }
  }

  await activeClient.session.promptAsync({
    path: { id: sessionId },
    body: {
      ...(agent ? { agent } : {}),
      parts,
    },
  });

  let latestText = "";
  const activeTools: Map<string, string> = new Map();
  let done = false;
  let answerCaptured = false;
  let compacted = false;
  let skipNextStop = false;  // After compaction, skip the auto-continue's garbage stop
  let assistantMessageId: string | undefined;

  const TIMEOUT_MS = 10 * 60 * 1000;
  const timeout = setTimeout(() => { done = true; }, TIMEOUT_MS);
  let postAnswerTimeout: ReturnType<typeof setTimeout> | undefined;

  try {
    for await (const event of stream) {
      if (done) break;
      if (abortSignal?.aborted) {
        console.log(`[opencode] Session ${sessionId} aborted — exiting SSE loop.`);
        break;
      }

      const evt = event as Event;

      if (evt.type === "message.part.updated") {
        const { part } = evt.properties;
        if (part.sessionID !== sessionId) continue;

        if (answerCaptured) {
          if (part.type === "compaction") {
            compacted = true;
            done = true;
            break;
          }
          continue;
        }

        if (part.type === "step-start") {
          assistantMessageId = (part as { messageID?: string }).messageID;
        } else if (part.type === "text") {
          if (!assistantMessageId) continue;
          if ((part as { messageID?: string }).messageID !== assistantMessageId) continue;
          latestText = part.text ?? "";
          if (onProgress && latestText) onProgress(latestText);
        } else if (part.type === "tool") {
          const stateType = getToolStateType(part);
          if (stateType === "running") {
            activeTools.set(part.callID, part.tool);
            if (onProgress) {
              const toolNames = [...activeTools.values()].join(", ");
              onProgress(latestText
                ? `${latestText}\n\n_Using: ${toolNames}..._`
                : `_Using: ${toolNames}..._`);
            }
          } else if (stateType === "completed" || stateType === "error") {
            activeTools.delete(part.callID);
          }
        } else if (part.type === "compaction") {
          console.log(`[opencode] Compaction event for session ${sessionId}`);
          compacted = true;
          skipNextStop = true;  // The auto-continue after compaction produces a garbage summary; skip it
          assistantMessageId = undefined;
          latestText = "";
          activeTools.clear();
        } else if (part.type === "step-finish") {
          const reason = (part as { reason?: string }).reason;
          if (reason === "stop") {
            if (skipNextStop) {
              // This is the auto-continue's compaction summary — discard it and keep listening
              console.log(`[opencode] Skipping post-compaction auto-continue stop for session ${sessionId}`);
              skipNextStop = false;
              assistantMessageId = undefined;
              latestText = "";
              continue;
            }
            answerCaptured = true;
            postAnswerTimeout = setTimeout(() => { done = true; }, 30_000);
          } else if (reason === "tool-calls" && skipNextStop) {
            // Agent is doing real work after compaction — don't skip its eventual stop
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
          done = true;
          break;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    if (postAnswerTimeout) clearTimeout(postAnswerTimeout);
    stream.return(undefined);
  }

  if (abortSignal?.aborted) {
    throw new Error("Session aborted");
  }

  if (!latestText) {
    console.warn("OpenCode returned empty answer via streaming for session:", sessionId);
    return { text: "I wasn't able to generate a response. Please try again.", isQuestion: false, compacted: false };
  }

  const trimmed = latestText.trim();
  const isQuestion = trimmed.endsWith("?");

  return { text: latestText, isQuestion, compacted };
}
