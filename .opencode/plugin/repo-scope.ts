import { readFileSync } from "node:fs";
import { resolve, normalize } from "node:path";
import Database from "better-sqlite3";

/**
 * OpenCode plugin that constrains file access on a per-session basis.
 *
 * When a tool call comes in, the plugin:
 * 1. Looks up the session ID → channel ID (via the sessions table)
 * 2. Looks up the channel → repo name (via the channel_repos table)
 * 3. Looks up the repo → directory path (via the repos table)
 * 4. Blocks file access outside that repo's directory
 *
 * If no channel-specific repo is configured, falls back to the default repo.
 * If no repos are configured at all, fails open (allows everything).
 */

const DB_PATH = process.env.SESSIONS_DB_PATH || "/home/appuser/.local/share/opencode/sessions.db";

// Also allow access to /tmp (for scratch work) and the .opencode dir
const ALWAYS_ALLOWED = ["/tmp", "/app/repo/.opencode"];

// Cache resolved session→dirs mappings (TTL: 30s)
const sessionCache = new Map<string, { dirs: string[]; ts: number }>();
const CACHE_TTL_MS = 30_000;

let db: Database.Database | null = null;

function getDb(): Database.Database | null {
  if (db) return db;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    return db;
  } catch {
    // DB not available yet (server starting up) — fail open
    return null;
  }
}

/**
 * Resolve the allowed directories for a given OpenCode session ID.
 * Returns the specific repo dir for the session's channel, plus the default repo.
 */
function getAllowedDirsForSession(sessionId: string): string[] {
  // Check cache
  const cached = sessionCache.get(sessionId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.dirs;
  }

  const database = getDb();
  if (!database) return []; // fail open

  try {
    // Step 1: session_id → channel_id
    const session = database
      .prepare("SELECT channel_id FROM sessions WHERE session_id = ?")
      .get(sessionId) as { channel_id: string | null } | undefined;

    const channelId = session?.channel_id;

    // Step 2: channel_id → repo_name (if channel has a specific repo)
    let repoName: string | undefined;
    if (channelId) {
      const channelRepo = database
        .prepare("SELECT repo_name FROM channel_repos WHERE channel_id = ?")
        .get(channelId) as { repo_name: string } | undefined;
      repoName = channelRepo?.repo_name;
    }

    // Step 3: Get the target repo dir
    const dirs: string[] = [];

    if (repoName) {
      const repo = database
        .prepare("SELECT dir FROM repos WHERE name = ? AND enabled = 1")
        .get(repoName) as { dir: string } | undefined;
      if (repo) {
        dirs.push(normalize(resolve(repo.dir)));
      }
    }

    // Always include the default repo (it's the OpenCode server's CWD)
    const defaultRepo = database
      .prepare("SELECT dir FROM repos WHERE is_default = 1 AND enabled = 1")
      .get() as { dir: string } | undefined;
    if (defaultRepo) {
      const defaultDir = normalize(resolve(defaultRepo.dir));
      if (!dirs.includes(defaultDir)) {
        dirs.push(defaultDir);
      }
    }

    // If no repos found at all, fail open
    if (dirs.length === 0) {
      sessionCache.set(sessionId, { dirs: [], ts: Date.now() });
      return [];
    }

    sessionCache.set(sessionId, { dirs, ts: Date.now() });
    return dirs;
  } catch {
    // Query failed — fail open
    return [];
  }
}

/**
 * Check if an absolute path is within one of the allowed directories.
 */
function isPathAllowed(filePath: string, allowedDirs: string[]): boolean {
  if (allowedDirs.length === 0) return true; // fail open

  const normalized = normalize(resolve(filePath));

  for (const allowed of ALWAYS_ALLOWED) {
    if (normalized.startsWith(allowed + "/") || normalized === allowed) return true;
  }

  for (const dir of allowedDirs) {
    if (normalized.startsWith(dir + "/") || normalized === dir) return true;
  }

  return false;
}

/**
 * Try to extract absolute paths from a bash command string.
 * Best-effort — only catches explicit absolute paths.
 */
function extractPathsFromBash(command: string): string[] {
  const paths: string[] = [];
  const segments = command.split(/\s*\|\s*/);
  for (const segment of segments) {
    const parts = segment.trim().split(/\s+/);
    for (const part of parts) {
      if (part.startsWith("-") || part === "" || part.startsWith("$")) continue;
      if (part.startsWith("/")) {
        paths.push(part);
      }
    }
  }
  return paths;
}

export default function repoScopePlugin() {
  return {
    name: "repo-scope",
    hooks: {
      "tool.execute.before": async (input: { tool: string; args: Record<string, unknown>; sessionID?: string }) => {
        const sessionId = input.sessionID;
        if (!sessionId) return; // no session context — fail open

        const allowedDirs = getAllowedDirsForSession(sessionId);
        if (allowedDirs.length === 0) return; // fail open

        const tool = input.tool;

        // File path tools: read, list
        if (tool === "read" || tool === "list") {
          const filePath = (input.args.filePath || input.args.path) as string | undefined;
          if (filePath && !isPathAllowed(filePath, allowedDirs)) {
            throw new Error(
              `Access denied: \`${filePath}\` is outside your assigned repository. ` +
              `You can only access files within: ${allowedDirs.join(", ")}`
            );
          }
        }

        // Search tools: grep, glob
        if (tool === "grep" || tool === "glob") {
          const searchPath = (input.args.path || input.args.directory) as string | undefined;
          if (searchPath && !isPathAllowed(searchPath, allowedDirs)) {
            throw new Error(
              `Access denied: \`${searchPath}\` is outside your assigned repository. ` +
              `You can only search within: ${allowedDirs.join(", ")}`
            );
          }
        }

        // Bash: check absolute paths in command
        if (tool === "bash") {
          const command = input.args.command as string | undefined;
          if (command) {
            const paths = extractPathsFromBash(command);
            for (const p of paths) {
              if (!isPathAllowed(p, allowedDirs)) {
                throw new Error(
                  `Access denied: command references \`${p}\` which is outside your assigned repository. ` +
                  `You can only access: ${allowedDirs.join(", ")}`
                );
              }
            }
          }
        }
      },
    },
  };
}
