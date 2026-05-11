import { hasRole } from "../sessions.js";

type Role = "anyone" | "developer" | "admin";

type Family = {
  key: string;
  title: string;
  /** Minimum role to see this family in the help listing. */
  visibleTo: Role;
  /** Short blurb shown in the master help list. */
  blurb: string;
  /** Full bullet list shown by `help <key>`. */
  lines: string[];
  /** Optional caveat about per-command role differences. */
  note?: string;
};

const FAMILIES: Family[] = [
  {
    key: "config",
    title: "Channel config",
    visibleTo: "anyone",
    blurb: "Set the channel's agent, tools, prompt, and repo.",
    lines: [
      "• `config get` — show all channel settings",
      "• `config set agent <name>` / `config get agent` / `config clear agent`",
      "• `config set tools <a,b>` / `config get tools` / `config clear tools`",
      "• `config set prompt <text>` / `config get prompt` / `config clear prompt`",
      "• `config set repo <name>` / `config get repo` / `config clear repo`",
      "• `config available agents|tools|repos` — list what can be selected",
    ],
  },
  {
    key: "repo",
    title: "Repos",
    visibleTo: "admin",
    blurb: "Register repos, set defaults, toggle skills, sync.",
    lines: [
      "• `repo list` — show all registered repos",
      "• `repo add <name> <url>` — clone and register",
      "• `repo remove <name>`",
      "• `repo set-default <name>`",
      "• `repo allow-skills <name> on|off` — toggle `.claude/skills/` and `.opencode/skill[s]/`",
      "• `repo sync` — pull latest for all repos",
    ],
  },
  {
    key: "tool",
    title: "Tools (MCP)",
    visibleTo: "anyone",
    note: "`tool list` is open to all; everything else is admin-only.",
    blurb: "Register MCP tools and manage their credentials.",
    lines: [
      "• `tool list` — show all registered tools",
      "• `tool add <name>` — register a new tool (conversational flow)",
      "• `tool remove <name>`",
      "• `tool enable|disable <name>`",
      "• `tool set-key <name> <key>` — for api_key tools",
      "• `tool auth <name>` — start OAuth flow",
      "• `tool auth-code <name> <code> <state>` — complete OAuth",
    ],
  },
  {
    key: "knowledge",
    title: "Knowledge",
    visibleTo: "anyone",
    note: "`list`, `view`, `sources` are open to all; mutations are admin-only.",
    blurb: "Curate the bot's shared knowledge base.",
    lines: [
      "• `knowledge list` — show all entries",
      "• `knowledge view <id>` — show one entry",
      "• `knowledge sources` — show source attribution",
      "• `knowledge add <title>: <body>` — create",
      "• `knowledge update <id>: <body>` — replace",
      "• `knowledge remove <id>`",
      "• `knowledge import` — attach `.md` files in the same message",
      "• `knowledge sync` — re-index",
    ],
  },
  {
    key: "role",
    title: "Roles",
    visibleTo: "anyone",
    note: "`role list` is open to all; add/remove is admin-only.",
    blurb: "Grant admin or developer access.",
    lines: [
      "• `role list` — show all roles",
      "• `role add @user admin|developer`",
      "• `role remove @user`",
    ],
  },
  {
    key: "github",
    title: "GitHub PAT",
    visibleTo: "anyone",
    note: "DM only. Each user manages their own PAT.",
    blurb: "Connect a personal-access token for coding sessions.",
    lines: [
      "• `github connect <pat>` — store an encrypted PAT",
      "• `github status` — show whether you have a PAT and its scopes",
      "• `github disconnect` — remove your PAT",
    ],
  },
  {
    key: "memory",
    title: "Memory",
    visibleTo: "anyone",
    blurb: "Save and recall facts across conversations.",
    lines: [
      "• `remember <text>` — save to current scope",
      "• `remember --channel <text>` — save to channel scope",
      "• `remember --global <text>` — save globally",
      "• `recall <query>` — search saved memories",
      "• `memories` — list everything you've saved",
      "• `forget #<id>` — delete one",
    ],
  },
  {
    key: "code",
    title: "Coding sessions",
    visibleTo: "developer",
    blurb: "Spin up a worktree-backed coding session in a thread.",
    lines: [
      "• `code <description>` — start a session in the current thread",
      "• `code --agent <name> <description>` — pick a specific agent",
      "Inside a coding thread:",
      "• `status` — show diff summary and session state",
      "• `agents` — list available coding agents",
      "• `pr [title]` — open a PR with the current changes",
      "• `done [title]` — finish + open PR + close session",
      "• `cancel` — discard the worktree",
    ],
  },
];

function userCanSee(userId: string, role: Role): boolean {
  if (role === "anyone") return true;
  if (role === "developer") return hasRole(userId, "developer");
  if (role === "admin") return hasRole(userId, "admin");
  return false;
}

function masterList(userId: string): string {
  const visible = FAMILIES.filter((f) => userCanSee(userId, f.visibleTo));
  const hidden = FAMILIES.filter((f) => !userCanSee(userId, f.visibleTo));

  const lines = [
    "*Slackode commands*",
    "",
    "Just @mention me with a question, or DM me. Below are the structured commands you can run.",
    "Type `help <topic>` for details on one family — e.g. `help repo`.",
    "",
  ];
  for (const f of visible) {
    lines.push(`*${f.title}* — ${f.blurb}  _(\`help ${f.key}\`)_`);
  }
  if (hidden.length > 0) {
    const roles = Array.from(new Set(hidden.map((f) => f.visibleTo))).join(" / ");
    lines.push("");
    lines.push(`_${hidden.length} more command group(s) available with ${roles} role._`);
  }
  return lines.join("\n");
}

function familyDetail(family: Family, userId: string): string {
  const lines = [`*${family.title}*`, ""];
  if (family.note) {
    lines.push(`_${family.note}_`);
    lines.push("");
  }
  lines.push(...family.lines);
  if (!userCanSee(userId, family.visibleTo)) {
    lines.push("");
    lines.push(`_You don't currently have the role required to run these commands._`);
  }
  return lines.join("\n");
}

/**
 * Top-level command listing for slackode.
 * Triggered by `help`, `commands`, `?`, or `help <family>`.
 */
export function handleHelpCommand(question: string, userId: string): string | null {
  const q = question.trim();
  const lower = q.toLowerCase();

  if (lower === "help" || lower === "commands" || lower === "?") {
    return masterList(userId);
  }

  const subMatch = lower.match(/^help\s+(\S+)$/);
  if (subMatch) {
    const key = subMatch[1];
    const family = FAMILIES.find((f) => f.key === key);
    if (!family) {
      const known = FAMILIES.map((f) => `\`${f.key}\``).join(", ");
      return `Unknown help topic \`${key}\`. Available topics: ${known}.\nOr just type \`help\` for the full list.`;
    }
    return familyDetail(family, userId);
  }

  return null;
}
