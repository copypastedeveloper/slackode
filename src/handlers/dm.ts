import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { getOrCreateSession, getChannelConfig, setChannelConfig, clearChannelConfig } from "../sessions.js";
import { askQuestion } from "../opencode.js";
import type { AskResult } from "../opencode.js";
import { markdownToSlack, splitMessage } from "../utils/formatting.js";
import { getSlackContext } from "../utils/slack-context.js";
import { createProgressUpdater } from "../utils/progress.js";

const MAX_CUSTOM_PROMPT_LENGTH = 1000;

type MessageArgs = SlackEventMiddlewareArgs<"message"> & AllMiddlewareArgs;

export async function handleDm({ event, client, context }: MessageArgs): Promise<void> {
  // Only handle direct messages (not bot messages or other subtypes)
  if (event.channel_type !== "im") return;
  if ("subtype" in event && event.subtype === "bot_message") return;
  if ("bot_id" in event) return;
  if (!("text" in event) || !event.text) return;

  // Strip any <@BOT_ID> mention (users often @-mention the bot even in DMs)
  const botUserId = context.botUserId;
  const question = event.text.replace(new RegExp(`<@${botUserId}>\\s*`, "g"), "").trim();
  if (!question) return;

  const userId = "user" in event ? event.user : undefined;
  if (!userId) return;

  // Compute thread key/ts early so /config replies can use them
  const threadKey =
    "thread_ts" in event && event.thread_ts
      ? event.thread_ts
      : event.ts;

  const threadTs = "thread_ts" in event ? event.thread_ts : event.ts;

  // ── config commands ──
  if (question.startsWith("config ") || question === "config") {
    const args = question.slice("config".length).trim();

    if (args.startsWith("set ")) {
      const prompt = args.slice("set ".length).trim();
      if (!prompt) {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs,
          text: "Usage: `config set <instructions>` — provide the custom instructions after `set`." });
        return;
      }
      if (prompt.length > MAX_CUSTOM_PROMPT_LENGTH) {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs,
          text: `Custom instructions must be ${MAX_CUSTOM_PROMPT_LENGTH} characters or fewer (yours: ${prompt.length}).` });
        return;
      }
      setChannelConfig(event.channel, prompt, userId);
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs,
        text: `Custom instructions set for your DMs:\n> ${prompt}` });
      return;
    }

    if (args === "show") {
      const config = getChannelConfig(event.channel);
      if (config) {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs,
          text: `Custom instructions for your DMs:\n> ${config.customPrompt}` });
      } else {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs,
          text: "No custom instructions set for your DMs." });
      }
      return;
    }

    if (args === "clear") {
      clearChannelConfig(event.channel);
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs,
        text: "Custom instructions cleared for your DMs." });
      return;
    }

    await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs,
      text: "Usage: `config set <instructions>`, `config show`, or `config clear`." });
    return;
  }

  // Post a placeholder
  const placeholder = await client.chat.postMessage({
    channel: event.channel,
    thread_ts: threadTs,
    text: "_Looking into this..._",
  });

  const placeholderTs = placeholder.ts!;

  try {
    const slackCtx = await getSlackContext(client, userId, event.channel, "dm");

    // Attach per-channel custom prompt if configured
    const channelConfig = getChannelConfig(event.channel);
    if (channelConfig) {
      slackCtx.customPrompt = channelConfig.customPrompt;
    }

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
