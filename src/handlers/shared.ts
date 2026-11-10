import type { WebClient } from "@slack/web-api";
import { hasRole } from "../sessions.js";
import { isRestarting } from "../opencode-server.js";
import { getActiveCodingSession } from "../coding-session.js";
import { getSlackContext, fetchThreadContext, fetchLinkedThreads, toConversationContext, type SlackContext } from "../utils/slack-context.js";
import { downloadFiles, TEXT_MIMES, type SlackFile } from "../utils/slack-files.js";
import type { ConvertedFile } from "../attachments.js";
import { SlackSurface, runTurn } from "../surfaces/slack.js";
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

    await handleQuestion({
      client,
      channel: channelId,
      threadTs,
      placeholderTs,
      question: finalQuestion,
      slackCtx,
      threadContext,
      files,
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
  /** Pre-fetched thread context for mid-thread @mentions. */
  threadContext?: string;
  /** File attachments (images/PDFs) converted to data URIs. */
  files?: ConvertedFile[];
}

/** Slack Q&A turn for mentions and DMs: builds the prompt context and hands off to the turn runner. */
export async function handleQuestion(opts: HandleQuestionOpts): Promise<void> {
  const { client, channel, threadTs, placeholderTs, question, slackCtx, threadContext, files } = opts;
  const surface = new SlackSurface({ client, channel, threadTs, placeholderTs, userId: slackCtx.userId });

  // Skip the Slack lookups below when the turn can't start anyway.
  if (isRestarting()) {
    await surface.restarting();
    return;
  }

  // Resolve any Slack thread links in the question text
  let linkedThreadContext: string | undefined;
  try {
    linkedThreadContext = await fetchLinkedThreads(client, question) || undefined;
  } catch (err) {
    console.warn("[linked-threads] Failed to fetch linked threads:", err);
  }

  await runTurn(surface, {
    question,
    // threadTs is surfaced so scheduler tools can tag jobs with their origin thread.
    context: toConversationContext({ ...slackCtx, threadTs, threadContext, linkedThreadContext }),
    files,
  });
}
