import type { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";
import type { OpencodeClient } from "@opencode-ai/sdk";
import {
  getOrCreateSession,
  getChannelConfig,
  getChannelAgent, getChannelTools, resolveAgent,
  isSessionCompacted, setSessionCompacted,
  hasRole,
} from "../sessions.js";
import { listJobs, getJobById, reassignJobOwner } from "../db/jobs.js";
import { runJob } from "../job-runner.js";
import { askQuestion, askForShorterResponse } from "../opencode.js";
import type { RepoInfo } from "../context-prefix.js";
import { isRestarting, waitForRestart } from "../opencode-server.js";
import { resolveRepoForChannel } from "../repo-manager.js";
import { getActiveCodingSession } from "../coding-session.js";
import { formatResponse } from "../utils/formatting.js";
import { getSlackContext, fetchThreadContext, fetchLinkedThreads, type SlackContext } from "../utils/slack-context.js";
import { downloadFiles, TEXT_MIMES, type SlackFile, type ConvertedFile } from "../utils/slack-files.js";
import { createProgressUpdater } from "../utils/progress.js";
import { handleConfigCommand } from "./config-commands.js";
import { handleToolCommand, advanceToolAdd } from "./tool-commands.js";
import { handleRepoCommand } from "./repo-commands.js";
import { handleRoleCommand } from "./role-commands.js";
import { handleGithubCommand } from "./github-commands.js";
import { handleCodeCommand } from "./code-commands.js";
import { handleCodingMessage, handleCodeStart } from "./coding-handler.js";
import { handleMemoryCommand } from "./memory-commands.js";
import { handleKnowledgeCommand, type KnowledgeImportFile } from "./knowledge-commands.js";
import { handleHelpCommand } from "./help-commands.js";
import { handleStatsCommand } from "./stats-commands.js";
import { handleScheduleCommand } from "./schedule-commands.js";

/** Send an ephemeral denial message visible only to the requesting user. */
async function denyAccess(
  client: WebClient, channelId: string, userId: string, threadTs: string, requiredRole: string,
): Promise<void> {
  await client.chat.postEphemeral({
    channel: channelId,
    user: userId,
    thread_ts: threadTs,
    text: `This command requires *${requiredRole}* permissions. Ask an admin to run \`role add @you ${requiredRole}\`.`,
  });
}

// ── processIncoming: shared pipeline for DMs and mentions ──

export interface IncomingOpts {
  text: string;
  files: SlackFile[];
  channelId: string;
  channelType: "dm" | "channel";
  userId: string;
  threadTs: string;
  eventTs: string;
  isThread: boolean;
  botUserId?: string;
  client: WebClient;
}

/**
 * Shared incoming-message pipeline used by both DM and mention handlers.
 * Handles: validation, command routing, placeholder, thread context,
 * file downloads, agent resolution, and Q&A via handleQuestion.
 */
export async function processIncoming(opts: IncomingOpts): Promise<void> {
  const {
    text: question, files: eventFiles, channelId, channelType,
    userId, threadTs, eventTs, isThread, botUserId, client,
  } = opts;

  const hasFiles = eventFiles.length > 0;

  // Validate: need text, files, or thread context to proceed
  if (!question && !hasFiles && !isThread) {
    if (channelType === "channel") {
      await client.chat.postMessage({
        channel: channelId,
        thread_ts: threadTs,
        text: "It looks like you mentioned me but didn't ask a question. How can I help?",
      });
    }
    return;
  }

  // ── Command routing (skip when files are attached) ──
  const channelName = channelType === "dm" ? "DM" : undefined;
  const slackCtx = await getSlackContext(client, userId, channelId, channelType);

  // ── Knowledge import with attached files (must be before !hasFiles guard) ──
  if (hasFiles && question && /^knowledge\s+import/i.test(question)) {
    if (!hasRole(userId, "admin")) {
      await denyAccess(client, channelId, userId, threadTs, "admin");
      return;
    }
    const downloaded = await downloadFiles(eventFiles, client, TEXT_MIMES);
    const mdFiles: KnowledgeImportFile[] = downloaded
      .filter((f) => f.filename.endsWith(".md"))
      .map((f) => ({
        filename: f.filename,
        content: Buffer.from(f.dataUri.split(",")[1], "base64").toString("utf-8"),
      }));
    const reply = await handleKnowledgeCommand(question, channelId, userId, mdFiles);
    await client.chat.postMessage({
      channel: channelId, thread_ts: threadTs,
      text: reply || "No `.md` files found in the attachments.",
    });
    return;
  }

  if (!hasFiles && question) {
    // ── Help (open to all) ──
    const helpReply = handleHelpCommand(question, userId);
    if (helpReply) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: helpReply });
      return;
    }

    // ── Stats (open to all, read-only) ──
    const statsReply = handleStatsCommand(question, channelId);
    if (statsReply) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: statsReply });
      return;
    }

    // ── Admin-only: tool commands (except "tool list") ──
    if (/^tool\s+/i.test(question) && !/^tool\s+list$/i.test(question)) {
      if (!hasRole(userId, "admin")) {
        await denyAccess(client, channelId, userId, threadTs, "admin");
        return;
      }
    }
    const toolReply = await handleToolCommand(question, channelId, userId, threadTs, client);
    if (toolReply) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: toolReply });
      return;
    }

    // ── Admin-only: tool add conversation flow ──
    if (hasRole(userId, "admin")) {
      const addReply = await advanceToolAdd(channelId, userId, question, client, threadTs);
      if (addReply === "__handled__") {
        return; // Already posted (e.g. OAuth button)
      }
      if (addReply) {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: addReply });
        return;
      }
    }

    // ── Open to all: channel-scoped config ──
    const configReply = await handleConfigCommand(
      question, channelId, channelName ?? slackCtx.channelName, userId, client,
    );
    if (configReply) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: configReply });
      return;
    }

    // ── Admin-only: repo commands ──
    if (/^repo\s+/i.test(question)) {
      if (!hasRole(userId, "admin")) {
        await denyAccess(client, channelId, userId, threadTs, "admin");
        return;
      }
    }
    const repoReply = await handleRepoCommand(question, channelId, userId, threadTs, client);
    if (repoReply) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: repoReply });
      return;
    }

    // ── Role management (admin-only for add/remove, list open to all) ──
    const roleReply = await handleRoleCommand(question, channelId, userId, threadTs, client);
    if (roleReply) {
      if (roleReply.length > 0) {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: roleReply });
      }
      return;
    }

    // ── GitHub PAT management (connect/disconnect/status) ──
    if (/^github\s+/i.test(question)) {
      const githubReply = await handleGithubCommand(question, channelId, channelType, userId, threadTs, client, eventTs);
      if (githubReply !== undefined) {
        if (githubReply.length > 0) {
          await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: githubReply });
        }
        return;
      }
    }

    const memoryReply = await handleMemoryCommand(question, channelId, userId);
    if (memoryReply) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: memoryReply });
      return;
    }

    // ── Scheduled jobs (developer-only for mutations, list/show open) ──
    if (/^schedule\b/i.test(question)) {
      const scheduleReply = await handleScheduleCommand(question, channelId, userId, client);
      if (scheduleReply) {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: scheduleReply });
        return;
      }
    }

    // ── Knowledge commands (admin-only for mutations, open for list/view) ──
    if (/^knowledge\s+/i.test(question)) {
      if (!/^knowledge\s+(list|view|sources)\b/i.test(question) && !hasRole(userId, "admin")) {
        await denyAccess(client, channelId, userId, threadTs, "admin");
        return;
      }
      const knowledgeReply = await handleKnowledgeCommand(question, channelId, userId);
      if (knowledgeReply) {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: knowledgeReply });
        return;
      }
    }
  }

  // ── Coding session routing (developer+ only) ──
  // 1. Check if this thread has an active coding session
  const existingCodingSession = getActiveCodingSession(threadTs);
  if (existingCodingSession) {
    if (!hasRole(userId, "developer")) {
      await denyAccess(client, channelId, userId, threadTs, "developer");
      return;
    }
    // Check for code-thread commands (status, pr, done, cancel)
    if (question) {
      const codeReply = await handleCodeCommand(question, threadTs, userId, client, channelId);
      if (codeReply) {
        await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: codeReply });
        return;
      }
    }

    // Route to coding handler
    await handleCodingMessage({
      text: question,
      files: eventFiles,
      channelId,
      userId,
      threadTs,
      eventTs,
      isThread,
      botUserId,
      client,
      slackCtx,
    });
    return;
  }

  // 2. Check if message starts with "code" command to start a new coding session
  //    Syntax: code [--agent <name>] <description>
  if (question) {
    const codeMatch = question.match(/^code\s+([\s\S]+)/i);
    if (codeMatch) {
      if (!hasRole(userId, "developer")) {
        await denyAccess(client, channelId, userId, threadTs, "developer");
        return;
      }
      let rest = codeMatch[1].trim();
      let agent: string | undefined;
      const agentMatch = rest.match(/^--agent\s+(\S+)\s*([\s\S]*)/i);
      if (agentMatch) {
        agent = agentMatch[1];
        rest = agentMatch[2].trim();
      }
      await handleCodeStart({
        description: rest || "Help me with this codebase.",
        agent,
        channelId,
        userId,
        threadTs,
        client,
        slackCtx,
        files: eventFiles,
        isThread,
        botUserId,
      });
      return;
    }
  }

  // ── Post placeholder ──
  const placeholder = await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: "_Looking into this..._",
  });
  const placeholderTs = placeholder.ts!;

  try {
    // ── Thread context + thread files ──
    let threadContext: string | undefined;
    let allFiles = [...eventFiles];
    if (isThread) {
      const ctx = await fetchThreadContext(
        client, channelId, threadTs, eventTs, botUserId,
      );
      threadContext = ctx.text || undefined;
      if (ctx.files.length > 0) {
        allFiles = [...allFiles, ...ctx.files];
      }
    }

    // ── Download files ──
    const files = allFiles.length > 0
      ? await downloadFiles(allFiles, client)
      : undefined;

    // If there was no text, no files, and no thread context, show an error
    if (!question && (!files || files.length === 0) && !threadContext) {
      await client.chat.update({
        channel: channelId,
        ts: placeholderTs,
        text: "_I couldn't process the attached file(s). Please try again with a supported image (PNG, JPEG, GIF, WebP) or PDF under 10 MB._",
      });
      return;
    }

    // Default question: use file-oriented prompt if files exist, otherwise
    // a generic prompt that lets thread context drive the answer.
    const finalQuestion = question || (files && files.length > 0
      ? "What is in this file?"
      : "Can you help with this?");

    const channelAgent = getChannelAgent(channelId);
    const channelTools = getChannelTools(channelId);
    const agent = resolveAgent(channelAgent, channelTools);
    const repo = resolveRepoForChannel(channelId);

    await handleQuestion({
      client,
      channel: channelId,
      threadTs,
      placeholderTs,
      question: finalQuestion,
      slackCtx,
      agent,
      tools: channelTools,
      threadContext,
      files,
      repo,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error(`[${channelType}] Error:`, err.message);
    if (err.stack) console.error(err.stack);
    if ("cause" in err && err.cause) console.error("[cause]", err.cause);
    // Log response body if it's an HTTP/SDK error
    const resp = (error as { response?: { status?: number; data?: unknown } }).response;
    if (resp) console.error("[response]", resp.status, JSON.stringify(resp.data));
    await client.chat.update({
      channel: channelId,
      ts: placeholderTs,
      text: "_Sorry, I ran into an issue processing your question. Please try again or rephrase._",
    });
  }
}

// ── handleQuestion: Q&A pipeline ──

export interface HandleQuestionOpts {
  client: WebClient;
  channel: string;
  threadTs: string;
  placeholderTs: string;
  question: string;
  slackCtx: SlackContext;
  /** Agent name resolved from channel config + tools. */
  agent?: string;
  /** Channel tools (e.g. ["linear", "sentry"]). */
  tools?: string[];
  /** Pre-fetched thread context for mid-thread @mentions. */
  threadContext?: string;
  /** File attachments (images/PDFs) converted to data URIs. */
  files?: ConvertedFile[];
  /** Resolved repo info for multi-repo support. */
  repo?: RepoInfo;
}

/**
 * Shared Q&A pipeline used by both the mention and DM handlers.
 * Handles: session management, progress updates, askQuestion, formatting,
 * and posting the response back to Slack.
 */
export async function handleQuestion(opts: HandleQuestionOpts): Promise<void> {
  const { client, channel, threadTs, placeholderTs, question, slackCtx, agent, tools, threadContext, files, repo } = opts;

  // If the OpenCode server is restarting, return a friendly message
  if (isRestarting()) {
    await client.chat.update({
      channel,
      ts: placeholderTs,
      text: "_I'm reconfiguring right now. Please try again in a few seconds._",
    });
    return;
  }

  // Surface the thread so scheduler tools can tag jobs with their origin thread.
  slackCtx.threadTs = threadTs;

  // Attach per-channel custom prompt if configured
  const channelConfig = getChannelConfig(channel);
  if (channelConfig) {
    slackCtx.customPrompt = channelConfig.customPrompt;
  }

  if (threadContext) {
    slackCtx.threadContext = threadContext;
  }

  // Resolve any Slack thread links in the question text
  try {
    const linked = await fetchLinkedThreads(client, question);
    if (linked) {
      slackCtx.linkedThreadContext = linked;
    }
  } catch (err) {
    console.warn("[linked-threads] Failed to fetch linked threads:", err);
  }

  const { sessionId, isNew } = await getOrCreateSession(threadTs, channel);

  // If a previous response triggered compaction, re-send full instructions
  // so the agent recovers its behavioral constraints, then clear the flag.
  const needsFullContext = isNew || isSessionCompacted(threadTs);
  if (!isNew && needsFullContext) {
    setSessionCompacted(threadTs, false);
  }

  // Set up throttled progress updates
  const progress = createProgressUpdater(client, channel, placeholderTs);

  const askOpts = {
    sessionId,
    question,
    ctx: slackCtx,
    onProgress: (status: string) => { progress.update(status); },
    isNewSession: needsFullContext,
    agent,
    tools,
    files,
    repo,
    analytics: {
      userId: slackCtx.userId,
      channelId: channel,
      channelName: slackCtx.channelName,
      threadKey: threadTs,
    },
  };

  // Snapshot existing jobs so we can detect any the agent creates during this
  // session and correct their (model-supplied) owner to the real requester.
  const jobIdsBefore = new Set(listJobs().map((j) => j.id));

  let result;
  try {
    result = await askQuestion(askOpts);
  } catch (err) {
    // If the server is restarting (tool config change killed it mid-flight),
    // wait for the restart to finish and retry once.
    if (isRestarting()) {
      progress.update("_Reconfiguring... I'll pick back up in a moment._");
      await waitForRestart();
      result = await askQuestion(askOpts);
    } else {
      throw err;
    }
  }

  // If compaction occurred during this response, flag the session so the
  // next message re-sends the full behavioral instructions.
  if (result.compacted) {
    setSessionCompacted(threadTs, true);
  }

  progress.stop();

  await safePostResponse({
    client, channel, threadTs, placeholderTs,
    rawMarkdown: result.text,
    sessionId,
  });

  // If the agent scheduled a job this session, its owner (created_by) was
  // model-supplied and may be wrong. Correct it to the real requester and fire
  // the deferred review run so the confirmation DM reaches the right person.
  await reconcilePendingJobOwnership(jobIdsBefore, slackCtx.userId, threadTs, client);
}

/**
 * Jobs created conversationally record a model-supplied owner (see the
 * scheduler MCP) and are flagged owner_pending with their first run deferred.
 * After the session, reassign any such new job to the authoritative requesting
 * user and fire its review run — the review posts only to the owner's DM
 * (probation), so this both fixes ownership and routes the confirmation DM
 * to the person who actually asked.
 *
 * Attribution: a new owner_pending job is claimed by this session when its
 * recorded thread_ts matches this thread (the reliable case — there is exactly
 * one Thread ID in context, so the model can't confuse it the way it confuses
 * user IDs). Jobs stamped with a *different* thread belong to a concurrent
 * session and are left alone. A job with no thread falls back to the
 * "created during this session's window" heuristic.
 */
async function reconcilePendingJobOwnership(
  before: Set<string>,
  userId: string | undefined,
  threadTs: string,
  client: WebClient,
): Promise<void> {
  if (!userId) return;
  let pending;
  try {
    pending = listJobs().filter((j) => {
      if (!j.owner_pending) return false;
      // Thread-tagged jobs: claim only our own thread's, ignore other threads'.
      if (j.thread_ts) return j.thread_ts === threadTs;
      // Untagged (model omitted Thread ID): fall back to the session window.
      return !before.has(j.id);
    });
  } catch (err) {
    console.error("[jobs] ownership reconcile: listJobs failed:", err);
    return;
  }
  for (const job of pending) {
    try {
      if (job.created_by !== userId) {
        console.log(`[jobs] correcting owner of ${job.name}: ${job.created_by} -> ${userId}`);
      }
      reassignJobOwner(job.id, userId);
      const fresh = getJobById(job.id);
      if (fresh) {
        // Fire-and-forget: the review run spawns its own session and DMs the owner.
        runJob(fresh, client).catch((err) =>
          console.error(`[jobs] deferred review run for ${fresh.name} failed:`, err),
        );
      }
    } catch (err) {
      console.error(`[jobs] ownership reconcile failed for ${job.name}:`, err);
    }
  }
}

// ── Safe Slack posting (catches msg_too_long and falls back) ──

export interface SafePostOpts {
  client: WebClient;
  channel: string;
  threadTs: string;
  placeholderTs: string;
  rawMarkdown: string;
  /** Session ID to retry with the same agent if msg_too_long. */
  sessionId?: string;
  /** Custom OpenCode client (for coding sessions). */
  customClient?: OpencodeClient;
  /** Custom base URL (for coding sessions). */
  customBaseUrl?: string;
  /** Append action buttons to the last message. */
  actionButtons?: KnownBlock;
}

export async function safePostResponse(opts: SafePostOpts): Promise<void> {
  const { client, channel, threadTs, placeholderTs, rawMarkdown, sessionId, customClient, customBaseUrl, actionButtons } = opts;

  const tryPost = async (markdown: string) => {
    const messages = formatResponse(markdown);
    if (actionButtons) {
      const last = messages[messages.length - 1];
      if (last.blocks.length >= 50) {
        // Last message is full — append buttons as a separate message
        messages.push({ text: "", blocks: [actionButtons] });
      } else {
        last.blocks.push(actionButtons);
      }
    }
    const first = messages[0];
    await client.chat.update({
      channel,
      ts: placeholderTs,
      text: first.text,
      ...(first.blocks && { blocks: first.blocks }),
    });
    for (let i = 1; i < messages.length; i++) {
      const msg = messages[i];
      await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: msg.text,
        ...(msg.blocks && { blocks: msg.blocks }),
      });
    }
  };

  try {
    await tryPost(rawMarkdown);
  } catch (err) {
    const isSlackError = err instanceof Error && err.message.includes("msg_too_long");
    if (!isSlackError) throw err;

    console.warn("[slack] msg_too_long — asking agent to shorten");
    await client.chat.update({
      channel,
      ts: placeholderTs,
      text: "_Response was too long — asking for a shorter version..._",
    });

    if (sessionId) {
      const shorter = await askForShorterResponse({ sessionId, customClient, customBaseUrl });
      await tryPost(shorter);
    } else {
      // No session to retry with — hard fallback
      await client.chat.update({
        channel,
        ts: placeholderTs,
        text: "(Response too long for Slack. Please try asking a more specific question.)",
      });
    }
  }
}
