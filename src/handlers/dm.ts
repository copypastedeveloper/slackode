import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import {
  getChannelAgent, getChannelTools, resolveAgent,
} from "../sessions.js";
import { getSlackContext } from "../utils/slack-context.js";
import { downloadFiles, type SlackFile } from "../utils/slack-files.js";
import { handleQuestion } from "./shared.js";
import { handleConfigCommand } from "./config-commands.js";

type MessageArgs = SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs;

export async function handleDm({ event, client, context }: MessageArgs): Promise<void> {
  // Only handle direct messages (not bot messages or other subtypes)
  if (event.channel_type !== "im") return;
  if ("subtype" in event && event.subtype === "bot_message") return;
  if ("bot_id" in event) return;

  // Extract text and files from the event
  const rawText = "text" in event ? event.text ?? "" : "";
  const eventFiles: SlackFile[] =
    "files" in event && Array.isArray((event as unknown as { files?: unknown[] }).files)
      ? ((event as unknown as { files: SlackFile[] }).files)
      : [];
  const hasFiles = eventFiles.length > 0;

  // Require at least text or files
  if (!rawText && !hasFiles) return;

  // Strip any <@BOT_ID> mention (users often @-mention the bot even in DMs)
  const botUserId = context.botUserId;
  const question = rawText.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim();
  if (!question && !hasFiles) return;

  const userId = "user" in event ? event.user : undefined;
  if (!userId) return;

  const threadTs =
    "thread_ts" in event && event.thread_ts
      ? event.thread_ts
      : event.ts;

  // ── config commands (skip when files are attached) ──
  if (!hasFiles && question) {
    const configReply = await handleConfigCommand(question, event.channel, "DM", userId);
    if (configReply) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: threadTs,
        text: configReply,
      });
      return;
    }
  }

  // Post a placeholder
  const placeholder = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: "_Looking into this..._",
  });

  const placeholderTs = placeholder.ts!;

  try {
    // Download file attachments
    const files = hasFiles
      ? await downloadFiles(eventFiles, client)
      : undefined;

    // If there was no text and all file downloads failed, show an error
    if (!question && (!files || files.length === 0)) {
      await client.chat.update({
        channel: event.channel,
        ts: placeholderTs,
        text: "_I couldn't process the attached file(s). Please try again with a supported image (PNG, JPEG, GIF, WebP) or PDF under 10 MB._",
      });
      return;
    }

    // Default question when files are attached without text
    const finalQuestion = question || "What is in this file?";

    const slackCtx = await getSlackContext(client, userId, event.channel, "dm");

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
      files,
    });
  } catch (error) {
    console.error("Error handling DM:", error);
    await client.chat.update({
      channel: event.channel,
      ts: placeholderTs,
      text: "_Sorry, I ran into an issue processing your question. Please try again or rephrase._",
    });
  }
}
