import type { WebClient } from "@slack/web-api";
import {
  addAgentCollaborator, removeAgentCollaborator, listAgentCollaborators, hasRole,
} from "../sessions.js";

/**
 * Register other AI agents/bots the assistant can hand work to:
 *   collaborator list
 *   collaborator add @agent <what it's good at>   (admin)
 *   collaborator remove @agent                    (admin)
 *
 * Registered collaborators are listed in the agent's instructions and via the
 * directory MCP's `list_agent_collaborators` tool, so it knows who to tag.
 *
 * Returns the reply text, or null if this isn't a collaborator command.
 */
export async function handleCollaboratorCommand(
  command: string, userId: string, client: WebClient,
): Promise<string | null> {
  const match = command.match(/^collaborators?(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  const sub = (match[1] ?? "list").trim();

  if (/^list$/i.test(sub)) {
    const rows = listAgentCollaborators();
    if (rows.length === 0) {
      return "No agent collaborators registered. An admin can add one with `collaborator add @agent <what it's good at>`.";
    }
    return `*Agent collaborators:*\n${rows.map((r) => `• ${r.name} (\`${r.user_id}\`) — ${r.description}`).join("\n")}`;
  }

  if (!hasRole(userId, "admin")) {
    return "Adding or removing collaborators requires *admin* permissions.";
  }

  const add = sub.match(/^add\s+<@([UW][A-Z0-9]+)(?:\|[^>]*)?>\s+([\s\S]+)$/i);
  if (add) {
    const [, id, description] = add;
    let name = id;
    try {
      const info = await client.users.info({ user: id });
      name = info.user?.real_name || info.user?.profile?.real_name || info.user?.name || id;
      if (!info.user?.is_bot) {
        return `That's a person, not a bot. Collaborators are other agents/apps — people are found automatically from the workspace directory.`;
      }
    } catch {
      return "I couldn't look up that user. Make sure you @-mention the agent's bot user.";
    }
    addAgentCollaborator(id, name, description.trim().slice(0, 500), userId);
    return `Added *${name}* as a collaborator: ${description.trim()}`;
  }

  const remove = sub.match(/^remove\s+<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/i);
  if (remove) {
    return removeAgentCollaborator(remove[1]) ? "Collaborator removed." : "That agent wasn't registered.";
  }

  return [
    "Collaborator commands:",
    "• `collaborator list`",
    "• `collaborator add @agent <what it's good at>` (admin)",
    "• `collaborator remove @agent` (admin)",
  ].join("\n");
}
