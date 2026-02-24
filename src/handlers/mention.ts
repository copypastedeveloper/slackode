import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { getOrCreateSession, getChannelAgent, setChannelAgent, clearChannelAgent, listChannelAgents } from "../sessions.js";
import { askQuestion } from "../opencode.js";
import type { AskResult } from "../opencode.js";
import { markdownToSlack, splitMessage } from "../utils/formatting.js";
import { getSlackContext } from "../utils/slack-context.js";
import { createProgressUpdater } from "../utils/progress.js";

type MentionArgs = SlackEventMiddlewareArgs<"app_mention"> & AllMiddlewareArgs;

/**
 * Handle config commands like:
 *   @bot config set agent <name>
 *   @bot config get agent
 *   @bot config clear agent
 *   @bot config list agents
 *
 * Returns the reply text if it was a config command, or null if not.
 */
async function handleConfigCommand(
  command: string,
  channelId: string,
  channelName: string
): Promise<string | null> {
  const match = command.match(/^config\s+(.+)$/i);
  if (!match) return null;

  const subcommand = match[1].trim();

  // config set agent <name>
  const setMatch = subcommand.match(/^set\s+agent\s+(\S+)$/i);
  if (setMatch) {
    const agent = setMatch[1];
    setChannelAgent(channelId, channelName, agent);
    return `Agent for #${channelName} set to \`${agent}\`. Messages in this channel will now use the \`${agent}\` agent profile.`;
  }

  // config get agent
  if (/^get\s+agent$/i.test(subcommand)) {
    const agent = getChannelAgent(channelId);
    if (agent) {
      return `#${channelName} is using the \`${agent}\` agent profile.`;
    }
    return `#${channelName} has no agent configured — using the default.`;
  }

  // config clear agent
  if (/^clear\s+agent$/i.test(subcommand)) {
    const removed = clearChannelAgent(channelId);
    if (removed) {
      return `Agent configuration for #${channelName} cleared. This channel will use the default agent.`;
    }
    return `#${channelName} had no agent configured.`;
  }

  // config list agents
  if (/^list\s+agents?$/i.test(subcommand)) {
    const rows = listChannelAgents();
    if (rows.length === 0) {
      return "No channel-specific agents configured. All channels are using the default agent.";
    }
    const lines = rows.map((r) => `• #${r.channel_name} → \`${r.agent}\``);
    return `*Channel agent mappings:*\n${lines.join("\n")}`;
  }

  return null;
}

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

  // Check for config commands before doing any Q&A work
  const slackCtx = await getSlackContext(client, event.user ?? "unknown", event.channel, "channel");
  const configReply = await handleConfigCommand(question, event.channel, slackCtx.channelName);
  if (configReply) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.thread_ts ?? event.ts,
      text: configReply,
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
    const { sessionId, isNew } = await getOrCreateSession(threadKey, slackCtx);

    // Set up throttled progress updates
    const progress = createProgressUpdater(client, event.channel, placeholderTs);

    const agent = getChannelAgent(event.channel);
    const result: AskResult = await askQuestion(sessionId, question, slackCtx, (status) => {
      progress.update(status);
    }, isNew, agent);

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
