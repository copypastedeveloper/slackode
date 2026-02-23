import type { WebClient } from "@slack/web-api";

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
        ctx.channelName = `#${chanInfo.channel.name}`;
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
