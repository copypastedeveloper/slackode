import type { WebClient } from "@slack/web-api";
import {
  getOrCreateSession,
  getChannelConfig,
  getChannelAgent, getChannelTools, resolveAgent,
  isSessionCompacted, setSessionCompacted,
} from "../sessions.js";
import { askQuestion, type RepoInfo } from "../opencode.js";
import { isRestarting, waitForRestart } from "../opencode-server.js";
import { resolveRepoForChannel } from "../repo-manager.js";
import { formatResponse } from "../utils/formatting.js";
import { getSlackContext, fetchThreadContext, fetchLinkedThreads, type SlackContext } from "../utils/slack-context.js";
import { downloadFiles, type SlackFile, type ConvertedFile } from "../utils/slack-files.js";
import { createProgressUpdater } from "../utils/progress.js";
import { handleConfigCommand } from "./config-commands.js";
import { handleToolCommand, advanceToolAdd } from "./tool-commands.js";
import { handleRepoCommand } from "./repo-commands.js";

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

  if (!hasFiles && question) {
    const toolReply = await handleToolCommand(question, channelId, userId, threadTs, client);
    if (toolReply) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: toolReply });
      return;
    }

    const addReply = advanceToolAdd(channelId, userId, question);
    if (addReply) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: addReply });
      return;
    }

    const configReply = await handleConfigCommand(
      question, channelId, channelName ?? slackCtx.channelName, userId,
    );
    if (configReply) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: configReply });
      return;
    }

    const repoReply = await handleRepoCommand(question, channelId, userId, threadTs, client);
    if (repoReply) {
      await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: repoReply });
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

// ── handleQuestion: low-level Q&A pipeline ──

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
  };

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

  // Format the response into Slack message payloads (with blocks for tables)
  const messages = formatResponse(result.text);

  // First message updates the placeholder
  const first = messages[0];
  await client.chat.update({
    channel,
    ts: placeholderTs,
    text: first.text,
    ...(first.blocks && { blocks: first.blocks }),
  });

  // Remaining messages posted as thread replies
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    await client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: msg.text,
      ...(msg.blocks && { blocks: msg.blocks }),
    });
  }
}
