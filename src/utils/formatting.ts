import { markdownToBlocks, splitBlocksWithText, blocksToPlainText } from "markdown-to-slack-blocks";
import type { KnownBlock } from "@slack/types";

export interface SlackMessagePayload {
  text: string;
  blocks: KnownBlock[];
}

/**
 * Convert raw LLM markdown into one or more Slack message payloads.
 * Tables become native TableBlocks; text uses rich_text blocks.
 * Messages are split to fit within Slack's size limits.
 */
export function formatResponse(markdown: string): SlackMessagePayload[] {
  const blocks = markdownToBlocks(markdown);
  const messages = splitBlocksWithText(blocks);
  return messages.map((m) => ({
    text: m.text,
    blocks: m.blocks as unknown as KnownBlock[],
  }));
}

/**
 * Convert raw LLM markdown to plain text suitable for Slack's `text` field.
 * Used by progress.ts for streaming updates (no blocks needed).
 */
export function markdownToPlainText(markdown: string): string {
  const blocks = markdownToBlocks(markdown);
  return blocksToPlainText(blocks);
}
