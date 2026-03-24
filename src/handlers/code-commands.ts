import type { WebClient } from "@slack/web-api";
import {
  getActiveCodingSession,
  getCodingSessionDiff,
  createCodingSessionPR,
  destroyCodingSession,
  listCodingAgents,
} from "../coding-session.js";
import { SessionStatus } from "../sessions.js";

/**
 * Handle commands inside an active coding thread.
 * Returns a reply string if the command was handled, or null if not a command.
 */
export async function handleCodeCommand(
  text: string,
  threadKey: string,
  userId: string,
  client: WebClient,
  channelId: string,
): Promise<string | null> {
  const trimmed = text.trim().toLowerCase();

  if (trimmed === "status") {
    return handleStatus(threadKey);
  }

  if (trimmed === "agents") {
    return handleListAgents(threadKey);
  }

  if (trimmed === "cancel") {
    return handleCancel(threadKey, userId);
  }

  const prMatch = trimmed.startsWith("pr") ? 2 : trimmed.startsWith("done") ? 4 : 0;
  if (prMatch) {
    const session = getActiveCodingSession(threadKey);
    if (session && (session.status === SessionStatus.PLANNING || session.status === SessionStatus.AWAITING_APPROVAL)) {
      return "The plan hasn't been approved yet. Approve the plan first, then create a PR.";
    }
    const title = text.trim().slice(prMatch).trim() || undefined;
    return handlePR(threadKey, userId, title, prMatch === 4);
  }

  // Not a code command — continue to coding Q&A
  return null;
}

export async function handleStatus(threadKey: string): Promise<string> {
  const session = getActiveCodingSession(threadKey);
  if (!session) return "_No active coding session in this thread._";

  const diff = getCodingSessionDiff(threadKey);
  if (!diff) return "_Could not retrieve changes._";

  const phaseLabel = session.status === SessionStatus.PLANNING ? " (planning)"
    : session.status === SessionStatus.AWAITING_APPROVAL ? " (awaiting plan approval)"
    : "";
  const agentLabel = session.agent !== "code" ? `\nAgent: \`${session.agent}\`` : "";
  const header = `*Coding session active${phaseLabel}*\nRepo: \`${session.repoName}\`\nBranch: \`${session.branch}\`${agentLabel}`;

  if (diff.changedFiles.length === 0) {
    return `${header}\n\nNo changes yet.`;
  }

  const fileList = diff.changedFiles.map((f) => `• \`${f}\``).join("\n");
  return `${header}\n\n*Changed files:*\n${fileList}\n\n\`\`\`\n${diff.diffstat}\n\`\`\``;
}

async function handleListAgents(threadKey: string): Promise<string> {
  const session = getActiveCodingSession(threadKey);
  if (!session) return "_No active coding session in this thread._";

  const agents = await listCodingAgents(threadKey);
  if (agents.length === 0) return "_No agents available._";

  const current = session.agent;
  const lines = agents.map((a) => {
    const marker = a.name === current ? " ← current" : "";
    const label = a.builtIn ? "" : " (repo)";
    return `• \`${a.name}\`${label}${marker}`;
  });

  return `*Available agents:*\n${lines.join("\n")}\n\nTo start a session with a specific agent: \`code --agent <name> <description>\``;
}

export async function handleCancel(threadKey: string, userId: string): Promise<string> {
  const session = getActiveCodingSession(threadKey);
  if (!session) return "_No active coding session to cancel._";

  const diff = getCodingSessionDiff(threadKey);
  const hasChanges = diff && diff.changedFiles.length > 0;

  await destroyCodingSession(threadKey);

  if (hasChanges) {
    return `Coding session cancelled. ⚠️ Any uncommitted changes in the worktree have been discarded.`;
  }
  return `Coding session cancelled.`;
}

export async function handlePR(
  threadKey: string,
  userId: string,
  title: string | undefined,
  destroyAfter: boolean,
): Promise<string> {
  const session = getActiveCodingSession(threadKey);
  if (!session) return "_No active coding session._";

  try {
    const { prUrl, diffstat, changedFiles } = await createCodingSessionPR(threadKey, title);

    const fileList = changedFiles.map((f) => `• \`${f}\``).join("\n");
    let msg = `*Draft PR created!*\n${prUrl}\n\n*Changed files:*\n${fileList}\n\n\`\`\`\n${diffstat}\n\`\`\``;

    if (destroyAfter) {
      await destroyCodingSession(threadKey);
      msg += "\n\nCoding session ended.";
    } else {
      msg += "\n\nCoding session is still active — you can continue making changes.";
    }

    return msg;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `_Failed to create PR: ${message}_`;
  }
}
