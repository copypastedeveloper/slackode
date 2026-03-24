import type { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";
import {
  getChannelConfig,
  updateCodingSessionAgent, updateCodingSessionStatus,
  SessionStatus,
} from "../sessions.js";
import { enrichContextForCoding } from "../opencode.js";
import {
  getActiveCodingSession, createCodingSession, askCodingQuestion,
  listCodingAgents,
} from "../coding-session.js";
import { getSlackContext, fetchThreadContext, fetchLinkedThreads, type SlackContext } from "../utils/slack-context.js";
import { downloadFiles, type SlackFile, type ConvertedFile } from "../utils/slack-files.js";
import { createProgressUpdater } from "../utils/progress.js";
import { safePostResponse } from "./shared.js";
import { Action, BlockPrefix, MAX_AGENT_BUTTONS, HOSTNAME } from "../constants.js";

// ── Coding session button builders ──

export function codingActionButtons(threadTs: string): KnownBlock {
  return {
    type: "actions",
    block_id: `${BlockPrefix.CODING_ACTIONS}${threadTs}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Status" },
        action_id: Action.CODING_STATUS,
        value: threadTs,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Create PR" },
        action_id: Action.CODING_PR,
        value: threadTs,
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Done (PR & End)" },
        action_id: Action.CODING_DONE,
        value: threadTs,
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Cancel" },
        action_id: Action.CODING_CANCEL,
        value: threadTs,
        confirm: {
          title: { type: "plain_text", text: "Cancel coding session?" },
          text: { type: "plain_text", text: "Any uncommitted changes will be discarded." },
          confirm: { type: "plain_text", text: "Cancel session" },
          deny: { type: "plain_text", text: "Keep working" },
        },
        style: "danger",
      },
    ],
  } as KnownBlock;
}

function codingPRButtons(threadTs: string): KnownBlock {
  return {
    type: "actions",
    block_id: `${BlockPrefix.CODING_PR}${threadTs}_${Date.now()}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Create PR" },
        action_id: Action.CODING_PR,
        value: threadTs,
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Done (PR & End)" },
        action_id: Action.CODING_DONE,
        value: threadTs,
        style: "primary",
      },
    ],
  } as KnownBlock;
}

function codingPlanButtons(threadTs: string): KnownBlock {
  return {
    type: "actions",
    block_id: `${BlockPrefix.CODING_PLAN}${threadTs}_${Date.now()}`,
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Approve Plan" },
        action_id: Action.CODING_APPROVE,
        value: threadTs,
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Revise Plan" },
        action_id: Action.CODING_REVISE,
        value: threadTs,
      },
      {
        type: "button",
        text: { type: "plain_text", text: "Cancel" },
        action_id: Action.CODING_CANCEL,
        value: threadTs,
        confirm: {
          title: { type: "plain_text", text: "Cancel coding session?" },
          text: { type: "plain_text", text: "The session will be destroyed." },
          confirm: { type: "plain_text", text: "Cancel session" },
          deny: { type: "plain_text", text: "Keep planning" },
        },
        style: "danger",
      },
    ],
  } as KnownBlock;
}

/**
 * Remove coding action/PR buttons from all prior bot messages in the thread.
 * Called before posting a new response with buttons so only the latest has them.
 */
async function stripPriorCodingButtons(
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<void> {
  try {
    const replies = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 200,
    });
    for (const msg of replies.messages ?? []) {
      if (!msg.bot_id || !msg.blocks || !msg.ts) continue;
      const blocks = msg.blocks as KnownBlock[];
      const isStrippable = (b: KnownBlock) =>
        b.type === "actions" && "block_id" in b &&
        typeof (b as { block_id?: string }).block_id === "string" &&
        ((b as { block_id: string }).block_id.startsWith(BlockPrefix.CODING_PR) ||
         (b as { block_id: string }).block_id.startsWith(BlockPrefix.CODING_PLAN));
      const hasActionBlock = blocks.some(isStrippable);
      if (!hasActionBlock) continue;
      const cleaned = blocks.filter((b) => !isStrippable(b));
      await client.chat.update({
        channel,
        ts: msg.ts,
        text: msg.text ?? "",
        blocks: cleaned,
      });
    }
  } catch (err) {
    console.warn("[slack] Failed to strip prior coding buttons:", err);
  }
}

// ── Coding message handler ──

export interface CodingMessageOpts {
  text: string;
  files: SlackFile[];
  channelId: string;
  userId: string;
  threadTs: string;
  isThread: boolean;
  botUserId?: string;
  client: WebClient;
  slackCtx: SlackContext;
}

/**
 * Handle a message in an active coding thread.
 * Routes the user's message to the coding session's dedicated OpenCode server.
 */
export async function handleCodingMessage(opts: CodingMessageOpts): Promise<void> {
  const { text, files: eventFiles, channelId, userId, threadTs, isThread, botUserId, client, slackCtx } = opts;

  const session = getActiveCodingSession(threadTs);
  if (!session) return;

  // If awaiting approval, don't route to agent — tell user to use buttons
  if (session.status === SessionStatus.AWAITING_APPROVAL) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "_Please use the *Approve Plan* or *Revise Plan* buttons above to proceed. Click Revise if you'd like to give feedback._",
    });
    return;
  }

  // Strip buttons from prior messages while the bot is working
  await stripPriorCodingButtons(client, channelId, threadTs);

  const placeholder = await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: "_Working on it..._",
  });
  const placeholderTs = placeholder.ts!;

  try {
    // Fetch thread context if mid-thread — includes the prior Q&A conversation
    // so the coding agent knows what was discussed before "code" was invoked.
    let allFiles = [...eventFiles];
    if (isThread) {
      const ctx = await fetchThreadContext(client, channelId, threadTs, placeholder.ts!, botUserId);
      if (ctx.text) {
        slackCtx.threadContext = ctx.text;
      }
      if (ctx.files.length > 0) {
        allFiles = [...allFiles, ...ctx.files];
      }
    }

    // Download files
    const files = allFiles.length > 0
      ? await downloadFiles(allFiles, client)
      : undefined;

    const question = text || "Continue with the task.";

    // Attach custom prompt
    const channelConfig = getChannelConfig(channelId);
    if (channelConfig) {
      slackCtx.customPrompt = channelConfig.customPrompt;
    }

    // Resolve linked threads
    try {
      const linked = await fetchLinkedThreads(client, question);
      if (linked) slackCtx.linkedThreadContext = linked;
    } catch {
      // Non-fatal
    }

    const progress = createProgressUpdater(client, channelId, placeholderTs);

    const result = await askCodingQuestion({
      session,
      question,
      ctx: slackCtx,
      onProgress: (status: string) => { progress.update(status); },
      files,
    });

    progress.stop();

    // Check if the session was cancelled/destroyed while the agent was working.
    // If so, discard the response silently — the cancel handler already notified the user.
    const stillActive = getActiveCodingSession(threadTs);
    if (!stillActive) {
      console.log(`[coding] Session ${threadTs} was destroyed while agent was working — discarding response.`);
      await client.chat.delete({ channel: channelId, ts: placeholderTs }).catch(() => {});
      return;
    }

    // Choose buttons based on session phase
    const isPlanning = stillActive.status === SessionStatus.PLANNING;
    const buttons = isPlanning ? codingPlanButtons(threadTs) : codingPRButtons(threadTs);

    const serverUrl = `http://${HOSTNAME}:${stillActive.port}`;
    await safePostResponse({
      client, channel: channelId, threadTs, placeholderTs,
      rawMarkdown: result.text,
      sessionId: stillActive.opencodeSessionId ?? undefined,
      customClient: stillActive.client,
      customBaseUrl: serverUrl,
      actionButtons: buttons,
    });

    // After posting the plan, transition to awaiting approval
    if (isPlanning) {
      updateCodingSessionStatus(threadTs, SessionStatus.AWAITING_APPROVAL);
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    // If the session was aborted (cancelled), silently clean up the placeholder
    if (err.message === "Session aborted") {
      console.log(`[coding] Session ${threadTs} aborted — cleaning up placeholder.`);
      await client.chat.delete({ channel: channelId, ts: placeholderTs }).catch(() => {});
      return;
    }
    console.error("[coding] Error:", err.message);
    if (err.stack) console.error(err.stack);
    await client.chat.update({
      channel: channelId,
      ts: placeholderTs,
      text: `_Error in coding session: ${err.message}_`,
    });
  }
}

// ── Agent selection ──

interface PendingCodingRequest {
  description: string;
  channelId: string;
  userId: string;
  threadTs: string;
  client: WebClient;
  slackCtx: SlackContext;
  files: SlackFile[];
  isThread: boolean;
  botUserId?: string;
}
const pendingCodingRequests = new Map<string, PendingCodingRequest>();

/**
 * Resume a pending coding request after agent selection via button click.
 */
export async function resumeCodingWithAgent(
  threadTs: string,
  agent: string,
  client: WebClient,
  channelId: string,
): Promise<void> {
  const pending = pendingCodingRequests.get(threadTs);
  if (!pending) {
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: "_No pending request found. The session may have timed out._",
    });
    return;
  }
  pendingCodingRequests.delete(threadTs);

  // Update the session's agent
  const session = getActiveCodingSession(threadTs);
  if (session) {
    session.agent = agent;
    updateCodingSessionAgent(threadTs, agent);
  }

  const agentLabel = agent !== "code" ? `\nAgent: \`${agent}\`` : "";
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: `Using agent: \`${agent}\`${agentLabel}\n_Processing your request..._`,
  });

  await handleCodingMessage({
    text: pending.description,
    files: pending.files,
    channelId: pending.channelId,
    userId: pending.userId,
    threadTs: pending.threadTs,
    isThread: pending.isThread,
    botUserId: pending.botUserId,
    client: pending.client,
    slackCtx: pending.slackCtx,
  });
}

// ── Plan approval / revision ──

/**
 * Handle plan approval — transition to coding phase and execute the plan.
 */
export async function handleApprove(
  threadTs: string,
  userId: string,
  client: WebClient,
  channelId: string,
): Promise<void> {
  const session = getActiveCodingSession(threadTs);
  if (!session) {
    await client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: "_No active session._" });
    return;
  }

  // Strip plan buttons
  await stripPriorCodingButtons(client, channelId, threadTs);

  // Transition to active (coding) phase
  updateCodingSessionStatus(threadTs, SessionStatus.ACTIVE);

  const placeholder = await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: "_Plan approved! Executing changes..._",
  });

  try {
    const slackCtx = await getSlackContext(client, userId, channelId, "channel");
    const channelConfig = getChannelConfig(channelId);
    if (channelConfig) slackCtx.customPrompt = channelConfig.customPrompt;

    const progress = createProgressUpdater(client, channelId, placeholder.ts!);

    // The agent already has the plan in its conversation context —
    // just tell it to execute
    const result = await askCodingQuestion({
      session: { ...session, status: SessionStatus.ACTIVE },
      question: "The user has approved your plan. Now execute it — write all the code changes you described.",
      ctx: slackCtx,
      onProgress: (status: string) => { progress.update(status); },
    });

    progress.stop();

    // Check if the session was cancelled while the agent was executing
    const stillActive = getActiveCodingSession(threadTs);
    if (!stillActive) {
      console.log(`[coding] Session ${threadTs} was destroyed during execution — discarding response.`);
      await client.chat.delete({ channel: channelId, ts: placeholder.ts! }).catch(() => {});
      return;
    }

    const serverUrl = `http://${HOSTNAME}:${stillActive.port}`;
    await safePostResponse({
      client, channel: channelId, threadTs, placeholderTs: placeholder.ts!,
      rawMarkdown: result.text,
      sessionId: stillActive.opencodeSessionId ?? undefined,
      customClient: stillActive.client,
      customBaseUrl: serverUrl,
      actionButtons: codingPRButtons(threadTs),
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err.message === "Session aborted") {
      console.log(`[coding] Session ${threadTs} aborted during execution — cleaning up.`);
      await client.chat.delete({ channel: channelId, ts: placeholder.ts! }).catch(() => {});
      return;
    }
    console.error("[coding] Approve error:", err.message);
    await client.chat.update({
      channel: channelId,
      ts: placeholder.ts!,
      text: `_Error executing plan: ${err.message}_`,
    });
  }
}

/**
 * Handle plan revision request — keep in planning state and ask for feedback.
 */
export async function handleRevise(
  threadTs: string,
  _userId: string,
  client: WebClient,
  channelId: string,
): Promise<void> {
  const session = getActiveCodingSession(threadTs);
  if (!session) return;

  // Keep in planning state so the next message routes back through planning flow
  updateCodingSessionStatus(threadTs, SessionStatus.PLANNING);

  await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: "What would you like to change about the plan? Type your feedback and I'll revise it.",
  });
}

// ── Code start (new coding session) ──

interface CodeStartOpts {
  description: string;
  agent?: string;
  channelId: string;
  userId: string;
  threadTs: string;
  client: WebClient;
  slackCtx: SlackContext;
  files: SlackFile[];
  isThread: boolean;
  botUserId?: string;
}

/**
 * Start a new coding session in response to "code <description>".
 */
export async function handleCodeStart(opts: CodeStartOpts): Promise<void> {
  const { description, agent, channelId, userId, threadTs, client, slackCtx, files: eventFiles, isThread, botUserId } = opts;

  const startMsg = await client.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: "_Starting coding session... This may take 10-15 seconds while the environment initializes._",
  });
  const startMsgTs = startMsg.ts!;

  try {
    // Enrich the description with external context (Linear tickets, etc.) in parallel
    // with session creation — enrichment uses the Q&A server, session creation starts coding server
    const [enrichedDescription, session] = await Promise.all([
      enrichContextForCoding(description),
      createCodingSession(threadTs, userId, channelId, agent ?? "code", description),
    ]);

    // If no agent was explicitly specified, check for repo-provided agents
    if (!agent) {
      const allAgents = await listCodingAgents(threadTs);
      // Repo agents = not built-in (excludes code, build, context, compaction, title, summary, build-* variants, etc.)
      const repoAgents = allAgents.filter((a) => !a.builtIn);
      console.log(`[coding] Repo agents: [${repoAgents.map((a) => a.name).join(", ")}]`);

      if (repoAgents.length > 0) {
        // Store pending request and show agent selection
        pendingCodingRequests.set(threadTs, {
          description: enrichedDescription, channelId, userId, threadTs, client, slackCtx,
          files: eventFiles, isThread, botUserId,
        });

        const agentButtons: KnownBlock = {
          type: "actions",
          block_id: `${BlockPrefix.AGENT_SELECT}${threadTs}`,
          elements: [
            // Default "code" agent always first
            {
              type: "button",
              text: { type: "plain_text", text: "code (default)" },
              action_id: `${Action.SELECT_AGENT_PREFIX}0`,
              value: JSON.stringify({ threadTs, agent: "code" }),
            },
            // Repo-provided agents (limited by Slack's 5-element-per-block constraint)
            ...repoAgents.slice(0, MAX_AGENT_BUTTONS - 1).map((a, i) => ({
              type: "button" as const,
              text: { type: "plain_text" as const, text: a.name },
              action_id: `${Action.SELECT_AGENT_PREFIX}${i + 1}`,
              value: JSON.stringify({ threadTs, agent: a.name }),
            })),
          ],
        } as KnownBlock;

        const selectText = `*Coding session ready!*\nRepo: \`${session.repoName}\`\nBranch: \`${session.branch}\`\n\nSelect an agent:`;
        await client.chat.update({
          channel: channelId,
          ts: startMsgTs,
          text: selectText,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: selectText } },
            agentButtons,
            codingActionButtons(threadTs),
          ],
        });
        return;
      }
    }

    // No agent selection needed — proceed immediately
    const agentLabel = session.agent !== "code" ? `\nAgent: \`${session.agent}\`` : "";

    const startText = `*Coding session started!*\nRepo: \`${session.repoName}\`\nBranch: \`${session.branch}\`${agentLabel}\n\n_Processing your request..._`;
    await client.chat.update({
      channel: channelId,
      ts: startMsgTs,
      text: startText,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: startText } },
        codingActionButtons(threadTs),
      ],
    });

    // Now route the enriched description as the first message
    await handleCodingMessage({
      text: enrichedDescription,
      files: eventFiles,
      channelId,
      userId,
      threadTs,
      isThread,
      botUserId,
      client,
      slackCtx,
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("[coding] Failed to start session:", err.message);
    await client.chat.update({
      channel: channelId,
      ts: startMsgTs,
      text: `_Failed to start coding session: ${err.message}_`,
    });
  }
}
