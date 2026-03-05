import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { SlackFile } from "../utils/slack-files.js";
import { processIncoming } from "./shared.js";

type MentionArgs = SlackEventMiddlewareArgs<"app_mention"> & AllMiddlewareArgs;

export async function handleMention({ event, client, context }: MentionArgs): Promise<void> {
  const botUserId = context.botUserId;
  const question = event.text.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim();

  const eventFiles: SlackFile[] =
    "files" in event && Array.isArray((event as unknown as { files?: unknown[] }).files)
      ? ((event as unknown as { files: SlackFile[] }).files)
      : [];

  await processIncoming({
    text: question,
    files: eventFiles,
    channelId: event.channel,
    channelType: "channel",
    userId: event.user ?? "unknown",
    threadTs: event.thread_ts ?? event.ts,
    eventTs: event.ts,
    isThread: !!event.thread_ts,
    botUserId,
    client,
  });
}
