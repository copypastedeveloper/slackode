import type { WebClient } from "@slack/web-api";
import type { SlackFile } from "./slack-files.js";

export interface SlackContext {
  userId: string;
  userName: string;
  userDisplayName: string;
  userTitle: string;
  userStatusText: string;
  channelId: string;
  channelName: string;
  channelTopic: string;
  channelPurpose: string;
  channelType: "dm" | "channel";
  customPrompt?: string;
  threadContext?: string;
}

export async function getSlackContext(
  client: WebClient,
  userId: string,
  channelId: string,
  channelType: "dm" | "channel"
): Promise<SlackContext> {
  const ctx: SlackContext = {
    userId,
    userName: "Unknown",
    userDisplayName: "",
    userTitle: "",
    userStatusText: "",
    channelId,
    channelName: channelType === "dm" ? "Direct Message" : "unknown-channel",
    channelTopic: "",
    channelPurpose: "",
    channelType,
  };

  // Fetch user profile
  try {
    const userInfo = await client.users.info({ user: userId });
    if (userInfo.user) {
      ctx.userName = userInfo.user.profile?.real_name ?? userInfo.user.name ?? "Unknown";
      ctx.userDisplayName = userInfo.user.profile?.display_name ?? "";
      ctx.userTitle = userInfo.user.profile?.title ?? "";
      ctx.userStatusText = userInfo.user.profile?.status_text ?? "";
    }
  } catch (err) {
    console.warn("Failed to fetch user info:", err);
  }

  // Fetch channel info (skip for DMs)
  if (channelType === "channel") {
    try {
      const chanInfo = await client.conversations.info({ channel: channelId });
      if (chanInfo.channel && "name" in chanInfo.channel) {
        ctx.channelName = chanInfo.channel.name ?? ctx.channelName;
        // topic and purpose contain useful context about what the channel is for
        const chan = chanInfo.channel as Record<string, unknown>;
        const topic = chan.topic as { value?: string } | undefined;
        const purpose = chan.purpose as { value?: string } | undefined;
        ctx.channelTopic = topic?.value ?? "";
        ctx.channelPurpose = purpose?.value ?? "";
      }
    } catch (err) {
      console.warn("Failed to fetch channel info:", err);
    }
  }

  return ctx;
}

// Max characters of thread context to include in the prompt
const MAX_THREAD_CONTEXT_CHARS = 3000;

export interface ThreadContextResult {
  text: string;
  files: SlackFile[];
}

/**
 * Fetch the preceding messages in a Slack thread and format them as context.
 * Excludes bot messages and the current message (identified by currentTs).
 * Also collects file attachments (images/PDFs) from thread messages.
 * Returns formatted text + files, or empty result if no thread or no messages.
 */
export async function fetchThreadContext(
  client: WebClient,
  channelId: string,
  threadTs: string,
  currentTs: string,
  botUserId?: string
): Promise<ThreadContextResult> {
  try {
    const result = await client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit: 50,  // reasonable cap
    });

    const messages = result.messages ?? [];

    // Build a user ID -> display name cache from the thread
    const userNames = new Map<string, string>();

    const lines: string[] = [];
    const threadFiles: SlackFile[] = [];

    for (const msg of messages) {
      // Skip the current message (the one that tagged the bot)
      if (msg.ts === currentTs) continue;
      // Skip bot messages
      if (msg.bot_id) continue;
      if (botUserId && msg.user === botUserId) continue;

      // Collect file attachments from thread messages
      const msgAny = msg as Record<string, unknown>;
      if (Array.isArray(msgAny.files)) {
        for (const f of msgAny.files) {
          const sf = f as SlackFile;
          if (sf.url_private && sf.mimetype && sf.name) {
            threadFiles.push(sf);
          }
        }
      }

      // Skip messages without text for the text context
      if (!msg.text) continue;

      // Resolve user name
      let name = "Unknown";
      if (msg.user) {
        if (userNames.has(msg.user)) {
          name = userNames.get(msg.user)!;
        } else {
          try {
            const info = await client.users.info({ user: msg.user });
            const resolved = info.user?.profile?.real_name ?? info.user?.name ?? "Unknown";
            userNames.set(msg.user, resolved);
            name = resolved;
          } catch {
            userNames.set(msg.user, "Unknown");
          }
        }
      }

      lines.push(`${name}: ${msg.text}`);
    }

    let combined = "";
    if (lines.length > 0) {
      combined = lines.join("\n");
      // Truncate from the beginning if too long (keep the most recent messages)
      if (combined.length > MAX_THREAD_CONTEXT_CHARS) {
        // Keep the tail (most recent messages)
        combined = combined.slice(-MAX_THREAD_CONTEXT_CHARS);
        // Clean up partial first line
        const firstNewline = combined.indexOf("\n");
        if (firstNewline > 0) {
          combined = "...\n" + combined.slice(firstNewline + 1);
        }
      }
    }

    return { text: combined, files: threadFiles };
  } catch (err) {
    console.warn("Failed to fetch thread context:", err);
    return { text: "", files: [] };
  }
}
