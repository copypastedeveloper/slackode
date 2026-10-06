import { markdownToBlocks, splitBlocksWithText, blocksToPlainText } from "markdown-to-slack-blocks";
import type { KnownBlock } from "@slack/types";

// Slack's hard limit on the `text` field is ~40,000 chars.
// We cap lower to leave room for metadata Slack adds.
const MAX_TEXT_LENGTH = 39_000;
// Slack allows at most 50 blocks per message.
const MAX_BLOCKS_PER_MESSAGE = 50;

export interface SlackMessagePayload {
  text: string;
  blocks: KnownBlock[];
}

const FENCE_RE = /^\s*(```|~~~)/;
const DELIMITER_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function tableCellCount(line: string): number {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).length;
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim() !== "";
}

function startsTable(lines: string[], i: number): boolean {
  const header = lines[i];
  const delimiter = lines[i + 1];
  if (delimiter === undefined || !isTableRow(header) || !delimiter.includes("|")) return false;
  return DELIMITER_RE.test(delimiter) && tableCellCount(header) === tableCellCount(delimiter);
}

/**
 * Make every GFM table standalone so the markdown parser recognizes it.
 *
 * LLMs often put a table directly under a list item or heading with no blank
 * line, or indent it inside a bullet. GFM treats those rows as paragraph
 * continuation text, so the table is lost and Slack shows raw pipes. This
 * dedents each table and surrounds it with blank lines. Fenced code blocks
 * are left untouched.
 */
export function normalizeTables(markdown: string): string {
  const lines = markdown.split("\n");
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (inFence || !startsTable(lines, i)) {
      out.push(line);
      continue;
    }
    if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
    let j = i;
    while (j < lines.length && isTableRow(lines[j])) out.push(lines[j++].trim());
    if (j < lines.length && lines[j].trim() !== "") out.push("");
    i = j - 1;
  }
  return out.join("\n");
}

function capText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text;
  return text.slice(0, MAX_TEXT_LENGTH - 3) + "...";
}

/**
 * Convert raw LLM markdown into one or more Slack message payloads.
 * Tables become native TableBlocks; text uses rich_text blocks.
 * Messages are split to fit within Slack's size limits.
 *
 * Slack only allows one TableBlock per message, so after the library splits,
 * we do a second pass to ensure no message contains more than one table.
 */
export function formatResponse(markdown: string): SlackMessagePayload[] {
  const blocks = markdownToBlocks(normalizeTables(markdown));
  const messages = splitBlocksWithText(blocks);

  // Second pass: split any message that still has multiple tables
  const result: SlackMessagePayload[] = [];
  for (const m of messages) {
    const msgBlocks = m.blocks as unknown as KnownBlock[];
    const tableIndices = msgBlocks
      .map((b, i) => (b.type === "table" ? i : -1))
      .filter((i) => i !== -1);

    if (tableIndices.length <= 1) {
      result.push({ text: m.text, blocks: msgBlocks });
      continue;
    }

    // Split at each table: [blocks before table + table] become separate messages
    let start = 0;
    for (const tableIdx of tableIndices) {
      const chunk = msgBlocks.slice(start, tableIdx + 1);
      const text = blocksToPlainText(chunk as never[]);
      result.push({ text, blocks: chunk });
      start = tableIdx + 1;
    }
    // Any remaining blocks after the last table
    if (start < msgBlocks.length) {
      const chunk = msgBlocks.slice(start);
      const text = blocksToPlainText(chunk as never[]);
      result.push({ text, blocks: chunk });
    }
  }

  // Final pass: enforce block count and text length limits per message
  const enforced: SlackMessagePayload[] = [];
  for (const msg of result) {
    if (msg.blocks.length > MAX_BLOCKS_PER_MESSAGE) {
      for (let i = 0; i < msg.blocks.length; i += MAX_BLOCKS_PER_MESSAGE) {
        const chunk = msg.blocks.slice(i, i + MAX_BLOCKS_PER_MESSAGE);
        const text = blocksToPlainText(chunk as never[]);
        enforced.push({ text: capText(text), blocks: chunk });
      }
    } else {
      enforced.push({ text: capText(msg.text), blocks: msg.blocks });
    }
  }

  return enforced;
}

/**
 * Convert raw LLM markdown to plain text suitable for Slack's `text` field.
 * Used by progress.ts for streaming updates (no blocks needed).
 */
export function markdownToPlainText(markdown: string): string {
  const blocks = markdownToBlocks(normalizeTables(markdown));
  return blocksToPlainText(blocks);
}

