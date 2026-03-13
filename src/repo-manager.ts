import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  getEnabledRepos, getDefaultRepo, getRepo, upsertRepo,
  setDefaultRepo as dbSetDefaultRepo, getChannelRepo,
  type RepoRow,
} from "./sessions.js";
import { generateContext } from "./context-gen.js";
import type { RepoInfo } from "./opencode.js";

/** Base directory for dynamically added repos. */
const REPOS_BASE_DIR = process.env.REPOS_BASE_DIR || "/app/repos";

/** Default repo directory (from env or /app/repo). */
const DEFAULT_REPO_DIR = process.env.REPO_DIR || "/app/repo";

/**
 * Sanitize a repo name for use as a directory name.
 * e.g. "myorg/myrepo" → "myorg-myrepo"
 */
function sanitizeName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "-");
}

/**
 * Derive a display name from a git URL.
 * e.g. "https://github.com/myorg/myrepo.git" → "myorg/myrepo"
 */
export function nameFromUrl(url: string): string {
  return url.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
}

/**
 * Clone a repo to a directory. Uses GIT_ASKPASS from the environment for auth.
 */
function cloneRepo(url: string, dir: string): void {
  console.log(`[repo-manager] Cloning ${url} to ${dir}...`);
  mkdirSync(path.dirname(dir), { recursive: true });
  execFileSync("git", ["clone", url, dir], {
    encoding: "utf-8",
    env: process.env,
    timeout: 5 * 60 * 1000,
  });
  cleanRepoAgents(dir);
  console.log(`[repo-manager] Clone complete: ${dir}`);
}

/**
 * Pull latest changes for a repo.
 */
function pullRepo(dir: string): void {
  try {
    execFileSync("git", ["pull", "--ff-only"], {
      cwd: dir,
      encoding: "utf-8",
      env: process.env,
      timeout: 2 * 60 * 1000,
    });
    cleanRepoAgents(dir);
  } catch (err) {
    console.warn(`[repo-manager] Pull failed for ${dir}:`, err);
  }
}

/**
 * Remove agent/skill/plugin files that could override the read-only behavior.
 * Mirrors the clean_repo_agents function in entrypoint.sh.
 * For the default repo, we preserve .opencode/plugin/ (our repo-scope plugin lives there).
 */
function cleanRepoAgents(dir: string): void {
  const isDefault = dir === DEFAULT_REPO_DIR;
  const dirsToRemove = [
    ".opencode/agents",
    ...(isDefault ? [] : [".opencode/plugin", ".opencode/plugins"]),
    ".claude", ".agents",
  ];
  const filesToRemove = [
    ".opencode/opencode.json", ".opencode/.opencode",
  ];
  for (const d of dirsToRemove) {
    const full = path.join(dir, d);
    if (existsSync(full)) rmSync(full, { recursive: true, force: true });
  }
  for (const f of filesToRemove) {
    const full = path.join(dir, f);
    if (existsSync(full)) rmSync(full, { force: true });
  }
}

/**
 * Ensure the .opencode/rules/ directory exists and copy base rule files
 * into the repo (same as entrypoint.sh does for the default repo).
 */
function ensureRulesDir(dir: string): void {
  const rulesDir = path.join(dir, ".opencode/rules");
  mkdirSync(rulesDir, { recursive: true });

  // Copy base rules from /app/.opencode/rules/ if they exist
  const baseRulesDir = "/app/.opencode/rules";
  if (existsSync(baseRulesDir)) {
    const files = getBaseRuleFiles(baseRulesDir);
    if (files.length > 0) {
      try {
        execFileSync("cp", ["-n", ...files, rulesDir], {
          encoding: "utf-8",
        });
      } catch {
        // Non-fatal — base rules may not exist in dev environments
      }
    }
  }
}

function getBaseRuleFiles(dir: string): string[] {
  try {
    return execFileSync("find", [dir, "-maxdepth", "1", "-name", "*.md", "-type", "f"], {
      encoding: "utf-8",
    }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Initialize the repo manager on startup.
 * Seeds the default repo from env if the DB repos table is empty.
 * Ensures all enabled repos are cloned and have context generated.
 */
export async function initRepos(): Promise<void> {
  // Create the base directory for additional repos
  mkdirSync(REPOS_BASE_DIR, { recursive: true });

  // Seed default repo from env if no repos exist in DB
  const existing = getEnabledRepos();
  if (existing.length === 0) {
    const repoUrl = process.env.REPO_URL;
    if (!repoUrl) {
      console.log("[repo-manager] No repos configured and REPO_URL not set. Skipping repo init.");
      return;
    }
    const name = process.env.TARGET_REPO || nameFromUrl(repoUrl);
    upsertRepo(name, repoUrl, DEFAULT_REPO_DIR, true);
    console.log(`[repo-manager] Seeded default repo: ${name}`);
  }

  // Ensure all enabled repos are cloned
  for (const repo of getEnabledRepos()) {
    if (!existsSync(path.join(repo.dir, ".git"))) {
      try {
        cloneRepo(repo.url, repo.dir);
      } catch (err) {
        console.error(`[repo-manager] Failed to clone ${repo.name}:`, err);
        continue;
      }
    }
    ensureRulesDir(repo.dir);
  }
}

/**
 * Add a new repo. Clones it and registers it in the DB.
 * Writes opencode.json and generates initial context.
 */
export async function addRepo(name: string, url: string): Promise<void> {
  const dir = path.join(REPOS_BASE_DIR, sanitizeName(name));

  if (existsSync(path.join(dir, ".git"))) {
    pullRepo(dir);
  } else {
    cloneRepo(url, dir);
  }

  ensureRulesDir(dir);

  // If this is the first repo, make it the default
  const isDefault = getEnabledRepos().length === 0;
  upsertRepo(name, url, dir, isDefault);

  // Generate context for the new repo (non-blocking)
  generateContext(dir, name).catch((err) => {
    console.error(`[repo-manager] Context generation failed for ${name}:`, err);
  });
}

/**
 * Pull all enabled repos.
 */
export function pullAllRepos(): void {
  for (const repo of getEnabledRepos()) {
    if (existsSync(path.join(repo.dir, ".git"))) {
      pullRepo(repo.dir);
    }
  }
}

/**
 * Generate context for all enabled repos.
 */
export async function generateContextForAllRepos(): Promise<void> {
  for (const repo of getEnabledRepos()) {
    try {
      await generateContext(repo.dir, repo.name);
    } catch (err) {
      console.error(`[context-gen] ${repo.name} failed:`, err);
    }
  }
}

/**
 * Resolve which repo a channel should use.
 * Returns the RepoInfo needed by the OpenCode prompt builder.
 */
export function resolveRepoForChannel(channelId: string): RepoInfo | undefined {
  const channelRepoName = getChannelRepo(channelId);
  const allRepos = getEnabledRepos();

  if (allRepos.length === 0) return undefined;

  let targetRepo: RepoRow;

  if (channelRepoName) {
    const found = getRepo(channelRepoName);
    if (found && found.enabled) {
      targetRepo = found;
    } else {
      // Configured repo not found/disabled — fall back to default
      targetRepo = getDefaultRepo() ?? allRepos[0];
    }
  } else {
    targetRepo = getDefaultRepo() ?? allRepos[0];
  }

  const otherRepos = allRepos
    .filter((r) => r.name !== targetRepo.name)
    .map((r) => ({ name: r.name, dir: r.dir }));

  return {
    name: targetRepo.name,
    dir: targetRepo.dir,
    isDefault: targetRepo.is_default === 1,
    otherRepos: otherRepos.length > 0 ? otherRepos : undefined,
  };
}
