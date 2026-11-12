import { strict as assert } from "node:assert";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

// buildPrefix reads tools/knowledge from SQLite; point it at a throwaway DB.
process.env.SESSIONS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "prefix-test-")), "sessions.db");

const { buildPrefix } = await import("./context-prefix.js");
const { toConversationContext } = await import("./utils/slack-context.js");
const { CASES } = await import("./__fixtures__/prefix-cases.js");

// Generated from the pre-refactor, Slack-only prompt builder. Slack prompts
// must stay byte-identical as the builder becomes surface-neutral.
const golden: Record<string, string> = JSON.parse(
  readFileSync(new URL("./__fixtures__/prefix-golden.json", import.meta.url), "utf8"),
);

describe("buildPrefix (Slack golden)", () => {
  for (const c of CASES) {
    for (const isNew of [true, false]) {
      const key = `${c.name}|${isNew ? "new" : "followup"}`;
      it(key, () => {
        const actual = buildPrefix({ ...c.opts, ctx: toConversationContext(c.ctx), isNew } as Parameters<typeof buildPrefix>[0]);
        assert.equal(actual, golden[key]);
      });
    }
  }
});

describe("buildPrefix (other surfaces)", () => {
  it("uses the surface's name, place and formatting rules", () => {
    const out = buildPrefix({
      isNew: true,
      mode: "qa",
      ctx: {
        surface: { name: "Linear", messageNoun: "Linear comments", formattingRules: ["Use Linear Markdown."] },
        requester: { id: "lin-u1", name: "Ada" },
        place: { label: "Issue", id: "ENG-12", name: "ENG-12 Fix login" },
        linkedConversation: "other issue",
      },
    });
    assert.match(out, /Your answers appear as Linear comments\./);
    assert.match(out, /5\. Use Linear Markdown\.\n6\. If you need clarification/);
    assert.match(out, /Issue: ENG-12 Fix login \(issue ID: ENG-12\)/);
    assert.match(out, /link to another Linear thread/);
    assert.doesNotMatch(out, /Slack/);
  });

  it("renders Linear's notes, issue URL and requester email", async () => {
    const { LINEAR_SURFACE } = await import("./surfaces/linear/agent.js");
    const out = buildPrefix({
      isNew: true,
      mode: "qa",
      ctx: {
        surface: LINEAR_SURFACE,
        requester: { id: "lin-u1", name: "Ada", email: "ada@example.com" },
        place: { label: "Issue", id: "ENG-12", name: "Fix login", url: "https://linear.app/x/issue/ENG-12" },
      },
    });
    assert.match(out, /User: Ada <ada@example\.com> \(user ID: lin-u1\)/);
    assert.match(out, /Issue: Fix login \(issue ID: ENG-12\)\nIssue URL: https:\/\/linear\.app/);
    assert.match(out, /Scheduling isn't available from Linear/);
  });
});
