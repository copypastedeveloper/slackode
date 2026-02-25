import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import {
  getChannelAgent, setChannelAgent, clearChannelAgent, listChannelAgents,
  getChannelTools, setChannelTools, clearChannelTools, listChannelTools,
  getChannelConfig, setChannelConfig, clearChannelConfig,
  resolveAgent,
} from "../sessions.js";
import { KNOWN_TOOLS, MAX_CUSTOM_PROMPT_LENGTH } from "../tools.js";
import { getSlackContext, fetchThreadContext } from "../utils/slack-context.js";
import { downloadFiles, type SlackFile } from "../utils/slack-files.js";
import { handleQuestion } from "./shared.js";

type MentionArgs = SlackEventMiddlewareArgs<"app_mention"> & AllMiddlewareArgs;

/**
 * Handle config commands like:
 *   @bot config set agent <name>
 *   @bot config get agent
 *   @bot config clear agent
 *   @bot config list agents
 *   @bot config set tools <tool1,tool2>
 *   @bot config get tools
 *   @bot config clear tools
 *   @bot config list tools
 *   @bot config available tools
 *
 * Returns the reply text if it was a config command, or null if not.
 */
async function handleConfigCommand(
  command: string,
  channelId: string,
  channelName: string,
  _userId: string
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

  // --- Tool commands ---

  // config set tools <tool1,tool2>
  const setToolsMatch = subcommand.match(/^set\s+tools?\s+(\S+)$/i);
  if (setToolsMatch) {
    const requested = setToolsMatch[1].split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
    const invalid = requested.filter((t) => !(t in KNOWN_TOOLS));
    if (invalid.length > 0) {
      const available = Object.keys(KNOWN_TOOLS).map((k) => `\`${k}\``).join(", ");
      return `Unknown tool${invalid.length > 1 ? "s" : ""}: ${invalid.map((t) => `\`${t}\``).join(", ")}. Available tools: ${available}`;
    }
    const unique = [...new Set(requested)].sort();
    if (unique.length === 0) {
      const available = Object.keys(KNOWN_TOOLS).map((k) => `\`${k}\``).join(", ");
      return `No valid tools specified. Please provide at least one tool name. Available tools: ${available}`;
    }
    setChannelTools(channelId, channelName, unique);
    return `Tools for #${channelName} set to ${unique.map((t) => `\`${t}\``).join(", ")}. Messages in this channel can now reference ${unique.join(" and ")} data.`;
  }

  // config get tools
  if (/^get\s+tools?$/i.test(subcommand)) {
    const tools = getChannelTools(channelId);
    if (tools && tools.length > 0) {
      return `#${channelName} has tools enabled: ${tools.map((t) => `\`${t}\``).join(", ")}`;
    }
    return `#${channelName} has no extra tools configured — using codebase Q&A only.`;
  }

  // config clear tools
  if (/^clear\s+tools?$/i.test(subcommand)) {
    const removed = clearChannelTools(channelId);
    if (removed) {
      return `Tools for #${channelName} cleared. This channel will use codebase Q&A only.`;
    }
    return `#${channelName} had no tools configured.`;
  }

  // config list tools
  if (/^list\s+tools?$/i.test(subcommand)) {
    const rows = listChannelTools();
    if (rows.length === 0) {
      return "No channel-specific tools configured.";
    }
    const lines = rows.map((r) => `• #${r.channel_name} → ${r.tools.split(",").map((t: string) => `\`${t}\``).join(", ")}`);
    return `*Channel tool mappings:*\n${lines.join("\n")}`;
  }

  // config available tools
  if (/^available\s+tools?$/i.test(subcommand)) {
    const lines = Object.entries(KNOWN_TOOLS).map(([name, desc]) => `• \`${name}\` — ${desc}`);
    return `*Available tools:*\n${lines.join("\n")}`;
  }

  // --- Custom prompt commands ---

  // config set prompt <text>
  const setPromptMatch = subcommand.match(/^set\s+prompt\s+(.+)$/is);
  if (setPromptMatch) {
    const prompt = setPromptMatch[1].trim();
    if (prompt.length > MAX_CUSTOM_PROMPT_LENGTH) {
      return `Custom instructions must be ${MAX_CUSTOM_PROMPT_LENGTH} characters or fewer (yours: ${prompt.length}).`;
    }
    setChannelConfig(channelId, prompt, _userId);
    return `Custom instructions set for #${channelName}:\n> ${prompt}`;
  }

  // config get prompt
  if (/^(get|show)\s+prompt$/i.test(subcommand)) {
    const config = getChannelConfig(channelId);
    if (config) {
      return `Custom instructions for #${channelName} (set by <@${config.configuredBy}>):\n> ${config.customPrompt}`;
    }
    return `#${channelName} has no custom instructions set.`;
  }

  // config clear prompt
  if (/^clear\s+prompt$/i.test(subcommand)) {
    clearChannelConfig(channelId);
    return `Custom instructions cleared for #${channelName}.`;
  }

  return [
    "Unrecognized config command. Available config commands:",
    "• config set agent <name>",
    "• config get agent",
    "• config clear agent",
    "• config list agents",
    "• config set tools <tool1,tool2>",
    "• config get tools",
    "• config clear tools",
    "• config list tools",
    "• config available tools",
    "• config set prompt <instructions>",
    "• config get prompt",
    "• config clear prompt",
  ].join("\n");
}

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

  // Check for config commands before doing any Q&A work (skip when files are attached)
  const slackCtx = await getSlackContext(client, userId, event.channel, "channel");
  if (!hasFiles && question) {
    const configReply = await handleConfigCommand(question, event.channel, slackCtx.channelName, userId);
    if (configReply) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts ?? event.ts,
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
