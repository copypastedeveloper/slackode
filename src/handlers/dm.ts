import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { SlackFile } from "../utils/slack-files.js";
import { processIncoming } from "./shared.js";

type MessageArgs = SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs;

export async function handleDm({ event, client, context }: MessageArgs): Promise<void> {
  if (event.channel_type !== "im") return;
  if ("subtype" in event && event.subtype === "bot_message") return;
  if ("bot_id" in event) return;

  const rawText = "text" in event ? event.text ?? "" : "";
  const eventFiles: SlackFile[] =
    "files" in event && Array.isArray((event as unknown as { files?: unknown[] }).files)
      ? ((event as unknown as { files: SlackFile[] }).files)
      : [];

  const botUserId = context.botUserId;
  const question = rawText.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim();

  const userId = "user" in event ? event.user : undefined;
  if (!userId) return;

  if (!question && eventFiles.length === 0) return;

  const isThread = "thread_ts" in event && !!event.thread_ts;
  const threadTs = isThread ? (event.thread_ts as string) : event.ts;

  await processIncoming({
    text: question,
    files: eventFiles,
    channelId: event.channel,
    channelType: "dm",
    userId,
    threadTs,
    eventTs: event.ts,
    isThread,
    botUserId,
    client,
  });
}
