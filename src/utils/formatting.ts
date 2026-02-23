/**
 * Convert GitHub-flavored markdown to Slack mrkdwn format.
 * Slack renders triple backticks natively, so code fences are left as-is.
 */
export function markdownToSlack(text: string): string {
  let result = text;

  // Convert bold: **text** or __text__ -> *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/__(.+?)__/g, "*$1*");

  // Convert italic: *text* (single) or _text_ -> _text_
  // Be careful not to re-convert already-converted bold markers.
  // Slack uses _text_ for italic, so single underscores are fine.
  // Single asterisks that aren't part of bold need to become underscores.
  // This is tricky -- skip for now since Slack handles _italic_ natively.

  // Convert strikethrough: ~~text~~ -> ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Convert links: [text](url) -> <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Convert headers: ## text -> *text*
  result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // Convert simple markdown tables to preformatted blocks
  result = convertTables(result);

  return result;
}

function convertTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inTable = false;
  let tableLines: string[] = [];

  for (const line of lines) {
    const isTableRow = /^\|(.+)\|$/.test(line.trim());
    const isSeparator = /^\|[\s\-:|]+\|$/.test(line.trim());

    if (isTableRow || isSeparator) {
      if (!inTable) {
        inTable = true;
        tableLines = [];
      }
      if (!isSeparator) {
        tableLines.push(line.trim());
      }
    } else {
      if (inTable) {
        result.push("```");
        result.push(...tableLines);
        result.push("```");
        inTable = false;
        tableLines = [];
      }
      result.push(line);
    }
  }

  // Handle table at end of text
  if (inTable) {
    result.push("```");
    result.push(...tableLines);
    result.push("```");
  }

  return result.join("\n");
}

/**
 * Split a message into chunks that fit within Slack's message limit.
 * Slack has a ~4000 char limit per message; we use 3000 to be safe.
 */
export function splitMessage(text: string, maxLength = 3000): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline boundary
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      // Fall back to splitting at a space
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      // Last resort: hard split
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}
