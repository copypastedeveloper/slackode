import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { getOrCreateSession } from "../sessions.js";
import { askQuestion } from "../opencode.js";
import type { AskResult } from "../opencode.js";
import { markdownToSlack, splitMessage } from "../utils/formatting.js";
import { getSlackContext } from "../utils/slack-context.js";
import { createProgressUpdater } from "../utils/progress.js";

type MessageArgs = SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs;

export async function handleDm({ event, client, context }: MessageArgs): Promise<void> {
  // Only handle direct messages (not bot messages or other subtypes)
  if (event.channel_type !== "im") return;
  if ("subtype" in event && event.subtype === "bot_message") return;
  if ("bot_id" in event) return;
  if (!("text" in event) || !event.text) return;

  const question = event.text.trim();
  if (!question) return;

  const userId = "user" in event ? event.user : undefined;
  if (!userId) return;

  // Use thread_ts if this is a threaded reply, otherwise use the message's
  // own ts — which will become the thread_ts for all future replies in the
  // thread the bot creates.
  const threadKey =
    "thread_ts" in event && event.thread_ts
      ? event.thread_ts
      : event.ts;

  const threadTs = "thread_ts" in event ? event.thread_ts : event.ts;

  // Post a placeholder
  const placeholder = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: "_Looking into this..._",
  });

  const placeholderTs = placeholder.ts!;

  try {
    const slackCtx = await getSlackContext(client, userId, event.channel, "dm");
    const { sessionId, isNew } = await getOrCreateSession(threadKey, slackCtx);

    // Set up throttled progress updates
    const progress = createProgressUpdater(client, event.channel, placeholderTs);

    const result: AskResult = await askQuestion(sessionId, question, slackCtx, (status) => {
      progress.update(status);
    }, isNew);

    progress.stop();

    // Format the response
    const formatted = markdownToSlack(result.text);
    const chunks = splitMessage(formatted);

    if (result.isQuestion) {
      // Agent is asking a clarifying question — post it as a new message
      // so it stays visible in the thread. Remove the placeholder.
      await client.chat.update({
        channel: event.channel,
        ts: placeholderTs,
        text: chunks[0],
      });

      for (let i = 1; i < chunks.length; i++) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: chunks[i],
        });
      }
    } else {
      // Normal answer — update the placeholder with the final text
      await client.chat.update({
        channel: event.channel,
        ts: placeholderTs,
        text: chunks[0],
      });

      for (let i = 1; i < chunks.length; i++) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: threadTs,
          text: chunks[i],
        });
      }
    }
  } catch (error) {
    console.error("Error handling DM:", error);
    await client.chat.update({
      channel: event.channel,
      ts: placeholderTs,
      text: "_Sorry, I ran into an issue processing your question. Please try again or rephrase._",
    });
  }
}
