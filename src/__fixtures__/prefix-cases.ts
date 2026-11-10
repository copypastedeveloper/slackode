/** Inputs for the context-prefix golden test (Slack-shaped, as the bot builds them). */
import type { SlackContext } from "../utils/slack-context.js";

const full: SlackContext = {
  userId: "U123",
  userName: "Ada Lovelace",
  userDisplayName: "ada",
  userTitle: "Staff Engineer",
  userStatusText: "heads down",
  channelId: "C456",
  channelName: "eng-questions",
  channelTopic: "Ask about the codebase",
  channelPurpose: "Engineering Q&A",
  channelType: "channel",
  threadTs: "1700000000.000100",
  customPrompt: "Answer tersely.",
  threadContext: "Bob: what does the ledger do?",
  linkedThreadContext: "Carol: see the migration plan",
};

const bare: SlackContext = {
  userId: "U999",
  userName: "Unknown",
  userDisplayName: "",
  userTitle: "",
  userStatusText: "",
  channelId: "D111",
  channelName: "Direct Message",
  channelTopic: "",
  channelPurpose: "",
  channelType: "dm",
};

const repo = {
  name: "other-repo",
  dir: "/nonexistent/other-repo",
  isDefault: false,
  otherRepos: [{ name: "main-repo", dir: "/nonexistent/main-repo" }],
};

export const CASES: Array<{ name: string; ctx: SlackContext; opts: Record<string, unknown> }> = [
  { name: "qa-full-tools-repo", ctx: full, opts: { mode: "qa", tools: ["linear", "sentry"], repo } },
  { name: "qa-bare", ctx: bare, opts: { mode: "qa" } },
  { name: "coding", ctx: full, opts: { mode: "coding", repoName: "main-repo", repoDir: "/nonexistent/main-repo" } },
  { name: "planning", ctx: bare, opts: { mode: "planning", repoName: "main-repo", repoDir: "/nonexistent/main-repo" } },
  { name: "minimal-coding", ctx: full, opts: { mode: "minimal-coding", repoName: "main-repo" } },
  { name: "minimal-planning", ctx: bare, opts: { mode: "minimal-planning", repoName: "main-repo" } },
];
