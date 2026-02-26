import type { WebClient } from "@slack/web-api";
import { markdownToPlainText } from "./formatting.js";

/** Throttled Slack message updater — at most once per interval */
export function createProgressUpdater(
  slackClient: WebClient,
  channel: string,
  ts: string,
  intervalMs = 2000
) {
  let lastUpdate = 0;
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush() {
    if (pending !== null) {
      const text = markdownToPlainText(pending);
      // Truncate to Slack's limit; we'll send the full response at the end
      const truncated = text.length > 3000 ? text.slice(0, 2997) + "..." : text;
      slackClient.chat.update({ channel, ts, text: truncated + "\n\n_Thinking..._" }).catch(() => {});
      lastUpdate = Date.now();
      pending = null;
    }
  }

  return {
    update(status: string) {
      pending = status;
      const elapsed = Date.now() - lastUpdate;
      if (elapsed >= intervalMs) {
        flush();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, intervalMs - elapsed);
      }
    },
    stop() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
