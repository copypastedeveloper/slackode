import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { getOrCreateSession } from "../sessions.js";
import { askQuestion } from "../opencode.js";
import type { AskResult } from "../opencode.js";
import { markdownToSlack, splitMessage } from "../utils/formatting.js";
import { getSlackContext } from "../utils/slack-context.js";
import { createProgressUpdater } from "../utils/progress.js";

type MentionArgs = SlackEventMiddlewareArgs<"app_mention"> & AllMiddlewareArgs;

export async function handleMention({ event, client, context }: MentionArgs): Promise<void> {
  const botUserId = context.botUserId;
  // Strip the <@BOT_ID> mention from the text
  const question = event.text.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim();

  if (!question) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts ?? event.ts,
      text: "It looks like you mentioned me but didn't ask a question. How can I help?",
    });
    return;
  }

  const userId = event.user ?? "unknown";
  const threadTs = event.thread_ts ?? event.ts;

  // Post a placeholder reply in the thread
  const placeholder = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: "_Looking into this..._",
  });

  const placeholderTs = placeholder.ts!;

  try {
    const threadKey = threadTs;
    const slackCtx = await getSlackContext(client, userId, event.channel, "channel");
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

    // Update the placeholder with the first chunk (whether answer or question)
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
  } catch (error) {
    console.error("Error handling mention:", error);
    await client.chat.update({
      channel: event.channel,
      ts: placeholderTs,
      text: "_Sorry, I ran into an issue processing your question. Please try again or rephrase._",
    });
  }
}
