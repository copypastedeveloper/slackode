import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import {
  getChannelAgent, getChannelTools, resolveAgent,
} from "../sessions.js";
import { getSlackContext, fetchThreadContext } from "../utils/slack-context.js";
import { downloadFiles, type SlackFile } from "../utils/slack-files.js";
import { handleQuestion } from "./shared.js";
import { handleConfigCommand } from "./config-commands.js";
import { handleToolCommand, advanceToolAdd } from "./tool-commands.js";

type MentionArgs = SlackEventMiddlewareArgs<"app_mention"> & AllMiddlewareArgs;

export async function handleMention({ event, client, context }: MentionArgs): Promise<void> {
  const botUserId = context.botUserId;
  // Strip the <@BOT_ID> mention from the text
  const question = event.text.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim();

  // Extract file attachments from the triggering message
  const eventFiles: SlackFile[] =
    "files" in event && Array.isArray((event as unknown as { files?: unknown[] }).files)
      ? ((event as unknown as { files: SlackFile[] }).files)
      : [];
  const hasFiles = eventFiles.length > 0;

  // If there's no question text, no files on this message, and it's not a thread
  // (so no chance of thread files), bail early.
  if (!question && !hasFiles && !event.thread_ts) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts ?? event.ts,
      text: "It looks like you mentioned me but didn't ask a question. How can I help?",
    });
    return;
  }

  const userId = event.user ?? "unknown";

  // Check for config/tool commands before doing any Q&A work (skip when files are attached)
  const slackCtx = await getSlackContext(client, userId, event.channel, "channel");
  const threadTs0 = event.thread_ts ?? event.ts;
  if (!hasFiles && question) {
    // Try tool commands first
    const toolReply = await handleToolCommand(question, event.channel, userId, threadTs0, client);
    if (toolReply) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs0,
        text: toolReply,
      });
      return;
    }

    // Check if this is a reply in an active `tool add` conversation
    const addReply = advanceToolAdd(event.channel, userId, question);
    if (addReply) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs0,
        text: addReply,
      });
      return;
    }

    const configReply = await handleConfigCommand(question, event.channel, slackCtx.channelName, userId);
    if (configReply) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs0,
        text: configReply,
      });
      return;
    }
  }

  const threadTs = event.thread_ts ?? event.ts;

  // Post a placeholder reply in the thread
  const placeholder = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: "_Looking into this..._",
  });

  const placeholderTs = placeholder.ts!;

  try {
    // If this is a thread mention, fetch preceding conversation + any files
    // shared earlier in the thread.
    let threadContext: string | undefined;
    let allFiles = [...eventFiles];
    if (event.thread_ts) {
      const ctx = await fetchThreadContext(
        client, event.channel, event.thread_ts, event.ts, context.botUserId
      );
      threadContext = ctx.text || undefined;
      if (ctx.files.length > 0) {
        allFiles = [...allFiles, ...ctx.files];
      }
    }

    const hasAnyFiles = allFiles.length > 0;

    // Download file attachments (from triggering message + thread)
    const files = hasAnyFiles
      ? await downloadFiles(allFiles, client)
      : undefined;

    // If there was no text, no files, and no thread context, show an error
    if (!question && (!files || files.length === 0) && !threadContext) {
      await client.chat.update({
        channel: event.channel,
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

    const channelAgent = getChannelAgent(event.channel);
    const channelTools = getChannelTools(event.channel);
    const agent = resolveAgent(channelAgent, channelTools);

    await handleQuestion({
      client,
      channel: event.channel,
      threadTs,
      placeholderTs,
      question: finalQuestion,
      slackCtx,
      agent,
      tools: channelTools,
      threadContext,
      files,
    });
  } catch (error) {
    console.error("Error handling mention:", error);
    await client.chat.update({
      channel: event.channel,
      ts: placeholderTs,
      text: "_Sorry, I ran into an issue processing your question. Please try again or rephrase._",
    });
  }
}
