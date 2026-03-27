import type { WebClient } from "@slack/web-api";
import { hasRole, setRole, removeRole, listPermissions, type Role } from "../sessions.js";

/**
 * Handle `role <subcommand>` commands.
 * Returns a reply string, or null if not a role command.
 */
export async function handleRoleCommand(
  command: string,
  channelId: string,
  userId: string,
  threadTs: string,
  client: WebClient,
): Promise<string | null> {
  const match = command.match(/^role\s+(.*)/i);
  if (!match) return null;

  const sub = match[1].trim();

  // role list — open to all
  if (/^list$/i.test(sub)) {
    const rows = listPermissions();
    if (rows.length === 0) {
      return "No roles assigned yet. Bootstrap admins by setting `ADMIN_USERS` in the environment.";
    }
    const lines = rows.map((r) => {
      const grantedBy = r.granted_by === "ENV" ? "environment" : `<@${r.granted_by}>`;
      return `• <@${r.user_id}> — *${r.role}* (granted by ${grantedBy})`;
    });
    return `*Assigned roles:*\n${lines.join("\n")}`;
  }

  // Everything below requires admin
  if (!hasRole(userId, "admin")) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      thread_ts: threadTs,
      text: "This command requires *admin* permissions. Ask an admin to run `role add @you admin`.",
    });
    return "";  // handled, but no public reply
  }

  // role add <@user> <admin|developer>
  const addMatch = sub.match(/^add\s+<@(U[A-Z0-9]+)(?:\|[^>]*)?>\s+(admin|developer)$/i);
  if (addMatch) {
    const targetId = addMatch[1];
    const role = addMatch[2].toLowerCase() as "admin" | "developer";
    setRole(targetId, role, userId);
    return `Done — <@${targetId}> is now a *${role}*.`;
  }

  // role remove <@user>
  const removeMatch = sub.match(/^remove\s+<@(U[A-Z0-9]+)(?:\|[^>]*)?>/i);
  if (removeMatch) {
    const targetId = removeMatch[1];
    if (targetId === userId) {
      return "You can't remove your own role. Ask another admin to do it.";
    }
    const removed = removeRole(targetId);
    if (!removed) {
      return `<@${targetId}> doesn't have an assigned role.`;
    }
    return `Done — <@${targetId}> has been removed from all roles (now a regular user).`;
  }

  return "Unknown role command. Usage:\n• `role list` — show all roles\n• `role add @user admin|developer` — assign a role\n• `role remove @user` — remove a role";
}
