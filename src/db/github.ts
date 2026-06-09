import { getDb } from "./index.js";
import { decrypt } from "../crypto.js";

export interface UserGithubTokenRow {
  user_id: string;
  encrypted_token: string;
  token_iv: string;
  token_tag: string;
  github_username: string;
  github_name: string;
  github_email: string;
  created_at: number;
  updated_at: number;
}

export function saveUserGithubToken(
  userId: string,
  encToken: string,
  iv: string,
  tag: string,
  username: string,
  name: string,
  email: string,
): void {
  getDb()
    .prepare(`
      INSERT OR REPLACE INTO user_github_tokens
        (user_id, encrypted_token, token_iv, token_tag, github_username, github_name, github_email, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
    `)
    .run(userId, encToken, iv, tag, username, name, email);
}

export function getUserGithubToken(userId: string): UserGithubTokenRow | undefined {
  return getDb()
    .prepare("SELECT * FROM user_github_tokens WHERE user_id = ?")
    .get(userId) as UserGithubTokenRow | undefined;
}

export function getUserGithubPAT(userId: string): {
  token: string;
  username: string;
  name: string;
  email: string;
} | undefined {
  const row = getUserGithubToken(userId);
  if (!row) return undefined;
  const token = decrypt(row.encrypted_token, row.token_iv, row.token_tag);
  return {
    token,
    username: row.github_username,
    name: row.github_name,
    email: row.github_email,
  };
}

export function deleteUserGithubToken(userId: string): boolean {
  const result = getDb()
    .prepare("DELETE FROM user_github_tokens WHERE user_id = ?")
    .run(userId);
  return result.changes > 0;
}
