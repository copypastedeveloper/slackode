import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { getOrCreateSession, getChannelConfig, setChannelConfig, clearChannelConfig } from "../sessions.js";
import { askQuestion } from "../opencode.js";
import type { AskResult } from "../opencode.js";
import { markdownToSlack, splitMessage } from "../utils/formatting.js";
import { getSlackContext, fetchThreadContext } from "../utils/slack-context.js";
import { createProgressUpdater } from "../utils/progress.js";

const MAX_CUSTOM_PROMPT_LENGTH = 1000;

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
        text: `Custom instructions set for this channel:\n> ${prompt}` });
      return;
    }

    if (args === "show") {
      const config = getChannelConfig(event.channel);
      if (config) {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs,
          text: `Custom instructions for this channel (set by <@${config.configuredBy}>):\n> ${config.customPrompt}` });
      } else {
        await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs,
          text: "No custom instructions set for this channel." });
      }
      return;
    }

    if (args === "clear") {
      clearChannelConfig(event.channel);
      await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs,
        text: "Custom instructions cleared for this channel." });
      return;
    }

    await client.chat.postMessage({ channel: event.channel, thread_ts: threadTs,
      text: "Usage: `config set <instructions>`, `config show`, or `config clear`." });
    return;
  }

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

    // Attach per-channel custom prompt if configured
    const channelConfig = getChannelConfig(event.channel);
    if (channelConfig) {
      slackCtx.customPrompt = channelConfig.customPrompt;
    }

    const { sessionId, isNew } = await getOrCreateSession(threadKey, slackCtx);

    // If this is a new session and the bot was tagged in an existing thread,
    // fetch the preceding conversation so the agent has context.
    if (isNew && event.thread_ts) {
      const threadCtx = await fetchThreadContext(
        client, event.channel, event.thread_ts, event.ts, context.botUserId
      );
      if (threadCtx) {
        slackCtx.threadContext = threadCtx;
      }
    }

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
