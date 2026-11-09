import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// buildPrefix reads global knowledge from SQLite; point it at a throwaway DB
// before any module that opens the DB is loaded.
process.env.SESSIONS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "slackode-prefix-")), "sessions.db");

let buildLinearPrefix: typeof import("./index.js").buildLinearPrefix;
let buildPrefix: typeof import("../context-prefix.js").buildPrefix;

before(async () => {
  ({ buildLinearPrefix } = await import("./index.js"));
  ({ buildPrefix } = await import("../context-prefix.js"));
});

const ctx = {
  userId: "user-ryan",
  userName: "Ryan",
  userEmail: "ryan@example.com",
  issueIdentifier: "ENG-1",
  issueTitle: "Statements",
  issueUrl: "https://linear.app/narmi/issue/ENG-1",
  guidance: "Always link the relevant file.",
};

test("the Linear prefix uses Linear formatting rules and issue context", () => {
  const prefix = buildLinearPrefix(ctx, { isNew: true, tools: [] });
  assert.match(prefix, /posted as comments on a Linear issue/);
  assert.doesNotMatch(prefix, /Slack messages/);
  assert.doesNotMatch(prefix, /native Slack tables/);
  assert.match(prefix, /Scheduling tools are not available here/);
  assert.match(prefix, /User: Ryan <ryan@example.com> \(asking from Linear\)/);
  assert.match(prefix, /Linear issue: ENG-1: Statements \(https:\/\/linear\.app\/narmi\/issue\/ENG-1\)/);
  assert.match(prefix, /<linear_guidance>\nAlways link the relevant file\.\n<\/linear_guidance>/);
  assert.doesNotMatch(prefix, /channel ID/);
});

test("a Linear follow-up gets the short reminder", () => {
  const prefix = buildLinearPrefix(ctx, { isNew: false, tools: [] });
  assert.match(prefix, /REMINDER/);
  assert.match(prefix, /\[Ryan in Linear ENG-1\]/);
});

test("the Slack prefix is unchanged when no surface is given", () => {
  const prefix = buildPrefix({
    ctx: {
      userId: "U1", userName: "Ryan", userDisplayName: "Ryan", userTitle: "", userStatusText: "",
      channelId: "C1", channelName: "eng", channelTopic: "", channelPurpose: "", channelType: "channel",
    },
    isNew: true,
    mode: "qa",
  });
  assert.match(prefix, /Your answers appear as Slack messages/);
  assert.match(prefix, /Channel: eng \(channel ID: C1, channel\)/);
  assert.doesNotMatch(prefix, /LINEAR:/);
});
