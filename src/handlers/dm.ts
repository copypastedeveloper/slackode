import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { getChannelConfig, setChannelConfig, clearChannelConfig } from "../sessions.js";
import { MAX_CUSTOM_PROMPT_LENGTH } from "../tools.js";
import { getSlackContext } from "../utils/slack-context.js";
import { downloadFiles, type SlackFile } from "../utils/slack-files.js";
import { handleQuestion } from "./shared.js";

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
  if (!hasFiles && (question.startsWith("config ") || question === "config")) {
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

    await handleQuestion({
      client,
      channel: event.channel,
      threadTs,
      placeholderTs,
      question: finalQuestion,
      slackCtx,
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
