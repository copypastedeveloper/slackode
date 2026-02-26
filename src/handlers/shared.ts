import type { WebClient } from "@slack/web-api";
import {
  getOrCreateSession,
  getChannelConfig,
  isSessionCompacted, setSessionCompacted,
} from "../sessions.js";
import { askQuestion } from "../opencode.js";
import { formatResponse } from "../utils/formatting.js";
import type { SlackContext } from "../utils/slack-context.js";
import type { ConvertedFile } from "../utils/slack-files.js";
import { createProgressUpdater } from "../utils/progress.js";

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
}

/**
 * Shared Q&A pipeline used by both the mention and DM handlers.
 * Handles: session management, progress updates, askQuestion, formatting,
 * and posting the response back to Slack.
 */
export async function handleQuestion(opts: HandleQuestionOpts): Promise<void> {
  const { client, channel, threadTs, placeholderTs, question, slackCtx, agent, tools, threadContext, files } = opts;

  // Attach per-channel custom prompt if configured
  const channelConfig = getChannelConfig(channel);
  if (channelConfig) {
    slackCtx.customPrompt = channelConfig.customPrompt;
  }

  if (threadContext) {
    slackCtx.threadContext = threadContext;
  }

  const { sessionId, isNew } = await getOrCreateSession(threadTs);

  // If a previous response triggered compaction, re-send full instructions
  // so the agent recovers its behavioral constraints, then clear the flag.
  const needsFullContext = isNew || isSessionCompacted(threadTs);
  if (!isNew && needsFullContext) {
    setSessionCompacted(threadTs, false);
  }

  // Set up throttled progress updates
  const progress = createProgressUpdater(client, channel, placeholderTs);

  const result = await askQuestion({
    sessionId,
    question,
    ctx: slackCtx,
    onProgress: (status) => { progress.update(status); },
    isNewSession: needsFullContext,
    agent,
    tools,
    files,
  });

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
