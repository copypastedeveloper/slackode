import { getDb } from "./index.js";

export interface RepoRow {
  name: string;
  url: string;
  dir: string;
  is_default: number;
  enabled: number;
  allow_skills: number;
  created_at: number;
  updated_at: number;
}

export function getRepo(name: string): RepoRow | undefined {
  return getDb()
    .prepare("SELECT * FROM repos WHERE name = ?")
    .get(name) as RepoRow | undefined;
}

export function getAllRepos(): RepoRow[] {
  return getDb()
    .prepare("SELECT * FROM repos ORDER BY name")
    .all() as RepoRow[];
}

export function getEnabledRepos(): RepoRow[] {
  return getDb()
    .prepare("SELECT * FROM repos WHERE enabled = 1 ORDER BY name")
    .all() as RepoRow[];
}

export function getDefaultRepo(): RepoRow | undefined {
  return getDb()
    .prepare("SELECT * FROM repos WHERE is_default = 1 LIMIT 1")
    .get() as RepoRow | undefined;
}

export function upsertRepo(name: string, url: string, dir: string, isDefault: boolean): void {
  getDb()
    .prepare(`
      INSERT INTO repos (name, url, dir, is_default, updated_at)
      VALUES (?, ?, ?, ?, unixepoch())
      ON CONFLICT(name) DO UPDATE SET
        url = excluded.url,
        dir = excluded.dir,
        is_default = excluded.is_default,
        updated_at = unixepoch()
    `)
    .run(name, url, dir, isDefault ? 1 : 0);
}

export function removeRepo(name: string): boolean {
  const database = getDb();
  const txn = database.transaction(() => {
    const result = database
      .prepare("DELETE FROM repos WHERE name = ?")
      .run(name);
    // Also remove any channel mappings pointing to this repo
    database
      .prepare("DELETE FROM channel_repos WHERE repo_name = ?")
      .run(name);
    return result.changes > 0;
  });
  return txn();
}

export function setDefaultRepo(name: string): void {
  const database = getDb();
  const txn = database.transaction(() => {
    database.prepare("UPDATE repos SET is_default = 0 WHERE is_default = 1").run();
    database.prepare("UPDATE repos SET is_default = 1, updated_at = unixepoch() WHERE name = ?").run(name);
  });
  txn();
}

export function setRepoEnabled(name: string, enabled: boolean): void {
  getDb()
    .prepare("UPDATE repos SET enabled = ?, updated_at = unixepoch() WHERE name = ?")
    .run(enabled ? 1 : 0, name);
}

export function setRepoAllowSkills(name: string, allow: boolean): void {
  getDb()
    .prepare("UPDATE repos SET allow_skills = ?, updated_at = unixepoch() WHERE name = ?")
    .run(allow ? 1 : 0, name);
}
