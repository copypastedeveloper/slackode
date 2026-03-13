import { resolve, normalize } from "node:path";
import Database, { type Statement } from "better-sqlite3";

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

// ── Caching ──
// Session→channel never changes after creation, so we cache indefinitely.
// Channel→repo can change via config commands, so we use a short TTL.
// We cap total entries to prevent unbounded growth.

const sessionToChannel = new Map<string, string | null>(); // sessionID → channelID (permanent)
const channelToDirs = new Map<string, { dirs: string[]; ts: number }>(); // channelID → dirs (TTL)
const CHANNEL_CACHE_TTL_MS = 60_000;
const MAX_SESSION_CACHE = 5_000;

// ── Prepared statements (created once per DB connection) ──
let db: Database.Database | null = null;
let stmtSessionChannel: Statement | null = null;
let stmtChannelRepo: Statement | null = null;
let stmtRepoDir: Statement | null = null;
let stmtDefaultRepo: Statement | null = null;

function getDb(): Database.Database | null {
  if (db) return db;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    stmtSessionChannel = db.prepare("SELECT channel_id FROM sessions WHERE session_id = ?");
    stmtChannelRepo = db.prepare("SELECT repo_name FROM channel_repos WHERE channel_id = ?");
    stmtRepoDir = db.prepare("SELECT dir FROM repos WHERE name = ? AND enabled = 1");
    stmtDefaultRepo = db.prepare("SELECT dir FROM repos WHERE is_default = 1 AND enabled = 1");
    return db;
  } catch {
    return null;
  }
}

/**
 * Resolve the channel ID for a session (cached permanently since it never changes).
 */
function getChannelForSession(sessionId: string): string | null {
  if (sessionToChannel.has(sessionId)) {
    return sessionToChannel.get(sessionId)!;
  }

  const database = getDb();
  if (!database || !stmtSessionChannel) return null;

  const row = stmtSessionChannel.get(sessionId) as { channel_id: string | null } | undefined;
  const channelId = row?.channel_id ?? null;

  // Evict oldest entries if cache is too large
  if (sessionToChannel.size >= MAX_SESSION_CACHE) {
    const firstKey = sessionToChannel.keys().next().value;
    if (firstKey) sessionToChannel.delete(firstKey);
  }

  sessionToChannel.set(sessionId, channelId);
  return channelId;
}

/**
 * Resolve the allowed directories for a channel (cached with TTL since config can change).
 */
function getDirsForChannel(channelId: string | null): string[] {
  const cacheKey = channelId ?? "__default__";
  const cached = channelToDirs.get(cacheKey);
  if (cached && Date.now() - cached.ts < CHANNEL_CACHE_TTL_MS) {
    return cached.dirs;
  }

  const database = getDb();
  if (!database || !stmtChannelRepo || !stmtRepoDir || !stmtDefaultRepo) return [];

  const dirs: string[] = [];

  // Look up channel-specific repo
  if (channelId) {
    const channelRepo = stmtChannelRepo.get(channelId) as { repo_name: string } | undefined;
    if (channelRepo) {
      const repo = stmtRepoDir.get(channelRepo.repo_name) as { dir: string } | undefined;
      if (repo) {
        dirs.push(normalize(resolve(repo.dir)));
      }
    }
  }

  // Always include the default repo
  const defaultRepo = stmtDefaultRepo.get() as { dir: string } | undefined;
  if (defaultRepo) {
    const defaultDir = normalize(resolve(defaultRepo.dir));
    if (!dirs.includes(defaultDir)) {
      dirs.push(defaultDir);
    }
  }

  channelToDirs.set(cacheKey, { dirs, ts: Date.now() });
  return dirs;
}

/**
 * Get the allowed directories for a session.
 */
function getAllowedDirsForSession(sessionId: string): string[] {
  const channelId = getChannelForSession(sessionId);
  return getDirsForChannel(channelId);
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
 * Extract absolute paths from a bash command string (best-effort).
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
        if (!sessionId) return;

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
