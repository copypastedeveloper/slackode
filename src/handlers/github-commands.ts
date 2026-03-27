import type { WebClient } from "@slack/web-api";
import { encrypt } from "../crypto.js";
import {
  saveUserGithubToken, getUserGithubPAT,
  deleteUserGithubToken,
} from "../sessions.js";

/** Build standard GitHub API headers for a given PAT. */
function githubHeaders(pat: string): Record<string, string> {
  return { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github+json" };
}

/**
 * Validate a GitHub PAT, fetch user info, encrypt, and store.
 * Throws on invalid token or API errors.
 * Returns the GitHub user info on success.
 */
export async function validateAndStoreGithubPAT(
  userId: string,
  pat: string,
): Promise<{ username: string; name: string; email: string }> {
  // Validate via GitHub API
  const userResp = await fetch("https://api.github.com/user", {
    headers: githubHeaders(pat),
  });

  if (!userResp.ok) {
    if (userResp.status === 401) {
      throw new Error("Invalid or expired GitHub token.");
    }
    throw new Error(`GitHub API error: ${userResp.status} ${userResp.statusText}`);
  }

  const user = (await userResp.json()) as {
    login: string;
    name: string | null;
    email: string | null;
  };

  let email = user.email;
  if (!email) {
    // Try to get primary verified email
    try {
      const emailsResp = await fetch("https://api.github.com/user/emails", {
        headers: githubHeaders(pat),
      });
      if (emailsResp.ok) {
        const emails = (await emailsResp.json()) as Array<{
          email: string;
          primary: boolean;
          verified: boolean;
        }>;
        const primary = emails.find((e) => e.primary && e.verified);
        if (primary) email = primary.email;
      }
    } catch {
      // Non-fatal — fall through to noreply
    }
  }

  // Fallback to noreply
  if (!email) {
    email = `${user.login}@users.noreply.github.com`;
  }

  const name = user.name || user.login;
  const username = user.login;

  // Encrypt and store
  const enc = encrypt(pat);
  saveUserGithubToken(userId, enc.ciphertext, enc.iv, enc.tag, username, name, email);

  return { username, name, email };
}

/**
 * Handle `github connect|disconnect|status` commands.
 * Returns a reply string if the command was handled, or undefined if not a github command.
 */
export async function handleGithubCommand(
  text: string,
  channelId: string,
  channelType: "dm" | "channel",
  userId: string,
  threadTs: string,
  client: WebClient,
): Promise<string | undefined> {
  const match = text.match(/^github\s+(connect|disconnect|status)(?:\s+([\s\S]*))?$/i);
  if (!match) return undefined;

  const subcommand = match[1].toLowerCase();
  const arg = match[2]?.trim();

  if (subcommand === "connect") {
    if (channelType === "channel") {
      // Post ephemeral so only the user sees it
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: threadTs,
        text: "For security, please DM me `github connect <your-pat>` instead.",
      });
      return ""; // Return empty string to indicate handled (caller won't post again)
    }

    if (!arg) {
      return "Usage: `github connect <your-github-pat>`\n\nCreate a token at <https://github.com/settings/tokens> with `repo` scope.";
    }

    try {
      const info = await validateAndStoreGithubPAT(userId, arg);
      return `GitHub connected! Commits and PRs will be attributed to *${info.name}* (${info.username}, ${info.email}).`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Failed to connect GitHub: ${msg}`;
    }
  }

  if (subcommand === "disconnect") {
    const deleted = deleteUserGithubToken(userId);
    return deleted
      ? "GitHub disconnected. You'll need to reconnect before starting a coding session."
      : "No GitHub connection found.";
  }

  if (subcommand === "status") {
    const info = getUserGithubPAT(userId);
    if (!info) {
      return "No GitHub account connected. Run `github connect <pat>` to connect.";
    }
    return `GitHub connected as *${info.name}* (\`${info.username}\`, ${info.email}).`;
  }

  return undefined;
}
