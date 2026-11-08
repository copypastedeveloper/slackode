#!/usr/bin/env node
/**
 * Local MCP server for finding people, user groups, and agent collaborators
 * in the Slack workspace, so the agent can tag the right person or team.
 *
 * Reads the directory cache that the main process refreshes hourly
 * (src/slack-directory.ts) — it needs no Slack token of its own.
 *
 * Tools:
 *   - find_people: search people by name, handle, or job title
 *   - find_groups: search user groups by handle, name, or description
 *   - find_people_by_email: map commit-author emails (git log/blame) to Slack users
 *   - list_agent_collaborators: other bots/agents registered for hand-offs
 *
 * Runs as a stdio-based MCP server spawned by OpenCode.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchSlackUsers, searchSlackUsergroups, findSlackUserByEmail, getSlackUser,
  listAgentCollaborators, countDirectory, userLabel,
  type SlackUserRow,
} from "../db/directory.js";

const server = new McpServer({ name: "directory", version: "1.0.0" });

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function describeUser(u: SlackUserRow): string {
  const parts = [`${userLabel(u)} — mention: <@${u.id}>`];
  if (u.handle) parts.push(`handle: ${u.handle}`);
  if (u.title) parts.push(`title: ${u.title}`);
  if (u.tz) parts.push(`tz: ${u.tz}`);
  if (u.is_bot) parts.push("bot");
  return `- ${parts.join(" | ")}`;
}

function emptyDirectoryHint(): string {
  const { users } = countDirectory();
  return users === 0 ? " (The directory cache is empty — it may still be syncing.)" : "";
}

server.tool(
  "find_people",
  "Find people in the Slack workspace by name, handle, or job title (e.g. 'jane', 'payments engineer', 'SRE lead'). " +
  "Returns each person's mention token to tag them, like <@U123>. Use it when someone outside the conversation is the right person to help.",
  {
    query: z.string().describe("Name, handle, or words from their job title"),
    include_bots: z.boolean().optional().describe("Also return bots/apps (default false)"),
  },
  async ({ query, include_bots }) => {
    const rows = searchSlackUsers(query, { includeBots: include_bots, limit: 10 });
    console.error(`[directory-mcp] find_people "${query}": ${rows.length} results`);
    if (rows.length === 0) return text(`No people found matching "${query}".${emptyDirectoryHint()}`);
    return text(rows.map(describeUser).join("\n"));
  },
);

server.tool(
  "find_groups",
  "Find Slack user groups (teams, on-call rotations) by handle, name, or description (e.g. 'payments', 'oncall', 'design'). " +
  "Returns each group's mention token to tag it, like <!subteam^S123>. Prefer a group over an individual when the question is for a team or rotation.",
  { query: z.string().describe("Team name, handle, or what the group covers") },
  async ({ query }) => {
    const rows = searchSlackUsergroups(query, 10);
    console.error(`[directory-mcp] find_groups "${query}": ${rows.length} results`);
    if (rows.length === 0) return text(`No user groups found matching "${query}".`);
    const lines = rows.map((g) => {
      const memberIds = g.members.split(",").filter(Boolean);
      const sample = memberIds
        .slice(0, 8)
        .map((id) => getSlackUser(id))
        .filter((u): u is SlackUserRow => !!u)
        .map(userLabel);
      const more = memberIds.length > sample.length ? `, +${memberIds.length - sample.length} more` : "";
      const desc = g.description ? ` | ${g.description}` : "";
      const members = sample.length ? ` | members: ${sample.join(", ")}${more}` : "";
      return `- @${g.handle} (${g.name}) — mention: <!subteam^${g.id}> | ${g.member_count} members${desc}${members}`;
    });
    return text(lines.join("\n"));
  },
);

server.tool(
  "find_people_by_email",
  "Map email addresses to Slack people. Use with `git log --format='%ae' -- <path>` or `git blame` to find who knows a piece of code, " +
  "then tag the most relevant recent author.",
  { emails: z.array(z.string()).min(1).max(25).describe("Email addresses to look up") },
  async ({ emails }) => {
    const lines = emails.map((email) => {
      const u = findSlackUserByEmail(email);
      return u ? `${email} → ${describeUser(u).slice(2)}` : `${email} → no Slack user found`;
    });
    console.error(`[directory-mcp] find_people_by_email: ${emails.length} emails`);
    return text(lines.join("\n"));
  },
);

server.tool(
  "list_agent_collaborators",
  "List other AI agents/bots in this workspace that you can hand work to, and what each is good at. " +
  "Tag one when part of the request is better handled by it.",
  {},
  async () => {
    const rows = listAgentCollaborators();
    if (rows.length === 0) return text("No agent collaborators are registered.");
    return text(rows.map((a) => `- ${a.name} — mention: <@${a.user_id}> | ${a.description}`).join("\n"));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[directory-mcp] Server started.");
