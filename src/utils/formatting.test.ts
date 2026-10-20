import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { formatResponse, normalizeTables } from "./formatting.js";

// Shape of a real reply whose tables reached Slack as raw pipes: each numbered
// item is followed directly by an unindented table and then bullets.
const NESTED_TABLES = [
  "Nothing on our side looks broken.",
  "",
  "1. **Screen-scraping (Intuit aggregator IPs `206.108.41.0/24`)**",
  "| Day | Users scraped | 200s | 429s |",
  "|---|---|---|---|",
  "| Sep 28–Oct 2 | 1,190–1,365 | 20k–24k | 0–2 |",
  "| **Oct 5** | **1,337** | **23.9k** | **0** |",
  "- Login, session and dashboard pages are all returning 200s.",
  "2. **Could anything on our end be blocking it?**",
  "- Beacon's prod was last deployed on Sep 28.",
  "3. **\"Fix now\" reconnects**",
  "| Day | Intuit users | Plaid users |",
  "|---|---|---|",
  "| Sep 28 | 12 | 183 |",
].join("\n");

const tableBlocks = (markdown: string) =>
  formatResponse(markdown).flatMap((m) => m.blocks.filter((b) => b.type === "table"));

describe("normalizeTables", () => {
  it("lifts tables that directly follow list items", () => {
    const tables = tableBlocks(NESTED_TABLES);
    assert.equal(tables.length, 2);
    assert.equal(formatResponse(NESTED_TABLES).length, 2, "one table per message");
  });

  it("dedents a table nested inside a bullet", () => {
    const md = "- Summary:\n  | Core | Supported |\n  |---|---|\n  | DNA | Yes |\n";
    assert.equal(tableBlocks(md).length, 1);
  });

  it("leaves a standalone table unchanged", () => {
    const md = "Intro\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nOutro\n";
    assert.equal(normalizeTables(md), md);
    assert.equal(tableBlocks(md).length, 1);
  });

  it("ignores pipes inside fenced code", () => {
    const md = "```\n| A | B |\n|---|---|\n| 1 | 2 |\n```\n";
    assert.equal(normalizeTables(md), md);
    assert.equal(tableBlocks(md).length, 0);
  });

  it("ignores a delimiter row whose cell count differs from the header", () => {
    const md = "a | b\n---\n";
    assert.equal(normalizeTables(md), md);
  });
});
