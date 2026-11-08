import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMentionPolicy, buildLoopInBlock, decodeLoopIn, encodeLoopIn, hasLiveMention, mentionToken,
  MAX_LIVE_MENTIONS, type DirectoryLookup, type MentionPolicy,
} from "./mentions.js";
import { formatResponse } from "./utils/formatting.js";
import { scoreMatch } from "./db/directory.js";

const users: Record<string, { label: string; isBot: boolean }> = {
  UASKER: { label: "Asker", isBot: false },
  UJANE: { label: "Jane Doe", isBot: false },
  UBOB: { label: "Bob", isBot: false },
  UAGENT: { label: "ReviewBot", isBot: true },
  USELF: { label: "Slackode", isBot: true },
};
const lookup: DirectoryLookup = {
  user: (id) => users[id],
  group: (id) => (id === "SPAY" ? { handle: "payments-oncall" } : undefined),
};
const policy = (p: Partial<MentionPolicy> = {}): MentionPolicy => ({
  mode: "suggest",
  participants: new Set(["UASKER", "UJANE"]),
  botUserId: "USELF",
  ...p,
});

test("suggest: participants ping, outsiders and groups become names + suggestions", () => {
  const r = applyMentionPolicy("Ask <@UJANE> or <@UBOB>, or <!subteam^SPAY|@payments-oncall>.", policy(), lookup);
  assert.equal(r.markdown, "Ask <@UJANE> or **Bob**, or **@payments-oncall**.");
  assert.equal(r.liveCount, 1);
  assert.deepEqual(r.suggestions, [
    { kind: "user", id: "UBOB", label: "Bob" },
    { kind: "group", id: "SPAY", label: "@payments-oncall" },
  ]);
});

test("tag: everyone known pings, labels are stripped", () => {
  const r = applyMentionPolicy("<@UBOB|bob> and <!subteam^SPAY|@payments>", policy({ mode: "tag" }), lookup);
  assert.equal(r.markdown, "<@UBOB> and <!subteam^SPAY>");
  assert.equal(r.liveCount, 2);
  assert.equal(r.suggestions.length, 0);
});

test("off: nobody pings and nothing is suggested", () => {
  const r = applyMentionPolicy("<@UJANE> <@UBOB> <!subteam^SPAY>", policy({ mode: "off" }), lookup);
  assert.equal(r.markdown, "**Jane Doe** **Bob** **@payments-oncall**");
  assert.equal(r.liveCount, 0);
  assert.equal(r.suggestions.length, 0);
});

test("broadcasts never ping, in Slack or plain form", () => {
  const r = applyMentionPolicy("<!here> hi @channel and @everyone, email a@here.com", policy({ mode: "tag" }), lookup);
  assert.ok(!/<!(here|channel|everyone)>/.test(r.markdown));
  assert.ok(r.markdown.includes("a@here.com"), "email-like text is left alone");
  // The library turns plain @here into a real broadcast — make sure ours survive formatting as text.
  const json = JSON.stringify(formatResponse(r.markdown));
  assert.ok(!json.includes("<!here>") && !json.includes("<!channel>") && !json.includes("<!everyone>"));
  assert.ok(!json.includes('"broadcast"'));
});

test("unknown IDs are treated as fabricated", () => {
  const r = applyMentionPolicy("Ask <@UFAKE123> or <!subteam^SNOPE>", policy({ mode: "tag" }), lookup);
  assert.equal(r.markdown, "Ask a teammate or a team");
  assert.equal(r.liveCount, 0);
});

test("participants not yet in the directory cache still ping", () => {
  const r = applyMentionPolicy("Thanks <@UNEWHIRE>", policy({ participants: new Set(["UNEWHIRE"]) }), lookup);
  assert.equal(r.markdown, "Thanks <@UNEWHIRE>");
});

test("never pings itself", () => {
  const r = applyMentionPolicy("I am <@USELF>", policy({ mode: "tag" }), lookup);
  assert.equal(r.markdown, "I am **Slackode**");
});

test("loop guard: replying to a bot never tags bots", () => {
  const r = applyMentionPolicy("<@UAGENT> done", policy({ mode: "tag", triggeredByBot: true }), lookup);
  assert.equal(r.markdown, "**ReviewBot** done");
  const normal = applyMentionPolicy("<@UAGENT> please review", policy({ mode: "tag" }), lookup);
  assert.equal(normal.markdown, "<@UAGENT> please review");
});

test("caps live mentions per response", () => {
  const many = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`UP${i}`, { label: `P${i}`, isBot: false }]));
  const big: DirectoryLookup = { user: (id) => many[id], group: () => undefined };
  const md = Object.keys(many).map((id) => `<@${id}>`).join(" ");
  const r = applyMentionPolicy(md, policy({ mode: "tag" }), big);
  assert.equal(r.liveCount, MAX_LIVE_MENTIONS);
});

test("tags render in sections and table cells", () => {
  const r = applyMentionPolicy("Owner: <@UJANE>\n\n| Area | Team |\n|---|---|\n| Billing | <!subteam^SPAY|@payments> |", policy({ mode: "tag" }), lookup);
  const json = JSON.stringify(formatResponse(r.markdown));
  assert.ok(json.includes("<@UJANE>"));
  // The table must still have two cells per row (no `|label` splitting the cell).
  const table = formatResponse(r.markdown).flatMap((m) => m.blocks).find((b) => b.type === "table") as unknown as { rows: unknown[][] };
  assert.ok(table, "table block present");
  assert.ok(table.rows.every((row) => row.length === 2));
  assert.ok(hasLiveMention(json));
});

test("loop-in buttons round-trip", () => {
  const s = { kind: "group" as const, id: "SPAY", label: "@payments-oncall" };
  assert.deepEqual(decodeLoopIn(encodeLoopIn(s)), s);
  assert.equal(decodeLoopIn("user:SNOTUSER:x"), null);
  assert.equal(mentionToken(s), "<!subteam^SPAY>");
  const block = buildLoopInBlock([s]) as unknown as { elements: Array<{ action_id: string; value: string }> };
  assert.equal(block.elements[0].action_id, "loop_in_0");
  assert.equal(buildLoopInBlock([]), null);
});

test("directory search scoring requires every token to match", () => {
  const fields = [{ value: "Jane Doe", weight: 3 }, { value: "Staff Engineer, Payments", weight: 2 }];
  assert.ok(scoreMatch("payments engineer", fields) > 0);
  assert.ok(scoreMatch("jane", fields) > scoreMatch("payments", fields));
  assert.equal(scoreMatch("jane frontend", fields), 0);
  assert.equal(scoreMatch("@jane", fields), scoreMatch("jane", fields));
});
