import { readFileSync } from "node:fs";
import { resolve, normalize } from "node:path";

/**
 * OpenCode plugin that constrains file access to allowed repository directories.
 *
 * Reads the list of allowed directories from /app/repo/.opencode/allowed-repos.json
 * (written by the bot process whenever repos change). Intercepts tool calls that
 * reference file paths (read, grep, glob, list, bash) and blocks access to paths
 * outside the allowed set.
 *
 * This provides a structural enforcement layer on top of prompt-based repo scoping.
 */

const ALLOWED_REPOS_FILE = process.env.ALLOWED_REPOS_FILE || "/app/repo/.opencode/allowed-repos.json";

// Also allow access to /tmp (for scratch work) and the .opencode dir itself
const ALWAYS_ALLOWED = ["/tmp", "/app/repo/.opencode"];

// Patterns in bash commands that indicate file system access with a path argument
const BASH_PATH_COMMANDS = /\b(cat|head|tail|less|more|wc|file|stat|ls|tree|find|grep|rg|awk|sed)\b/;

/**
 * Load allowed repo directories from the JSON file.
 * Returns a list of absolute directory paths.
 * Cached for 60s to avoid reading disk on every tool call.
 */
let cachedAllowed: string[] | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000;

function getAllowedDirs(): string[] {
  const now = Date.now();
  if (cachedAllowed && now - cacheTime < CACHE_TTL_MS) {
    return cachedAllowed;
  }
  try {
    const data = JSON.parse(readFileSync(ALLOWED_REPOS_FILE, "utf-8"));
    cachedAllowed = (data.dirs as string[]).map((d) => normalize(resolve(d)));
    cacheTime = now;
    return cachedAllowed;
  } catch {
    // If file doesn't exist or is invalid, allow everything (fail-open for safety on startup)
    return [];
  }
}

/**
 * Check if an absolute path is within one of the allowed directories.
 */
function isPathAllowed(filePath: string, allowedDirs: string[]): boolean {
  // If no allowed dirs configured, allow everything (fail-open)
  if (allowedDirs.length === 0) return true;

  const normalized = normalize(resolve(filePath));

  // Always-allowed paths
  for (const allowed of ALWAYS_ALLOWED) {
    if (normalized.startsWith(allowed + "/") || normalized === allowed) return true;
  }

  // Check against allowed repo dirs
  for (const dir of allowedDirs) {
    if (normalized.startsWith(dir + "/") || normalized === dir) return true;
  }

  return false;
}

/**
 * Try to extract a path argument from a bash command string.
 * This is best-effort — bash commands are complex and we can't parse all cases.
 * Returns the paths found, or empty array if we can't determine them.
 */
function extractPathsFromBash(command: string): string[] {
  const paths: string[] = [];

  // Split on pipes and process each segment
  const segments = command.split(/\s*\|\s*/);
  for (const segment of segments) {
    const parts = segment.trim().split(/\s+/);
    for (const part of parts) {
      // Skip flags, commands, and common non-path arguments
      if (part.startsWith("-") || part === "" || part.startsWith("$")) continue;
      // If it looks like an absolute path, check it
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
      "tool.execute.before": async (input: { tool: string; args: Record<string, unknown> }) => {
        const allowedDirs = getAllowedDirs();
        if (allowedDirs.length === 0) return; // fail-open if not configured

        const tool = input.tool;

        // Check file path tools: read, grep, glob, list
        if (tool === "read" || tool === "list") {
          const filePath = (input.args.filePath || input.args.path) as string | undefined;
          if (filePath && !isPathAllowed(filePath, allowedDirs)) {
            throw new Error(
              `Access denied: \`${filePath}\` is outside the allowed repositories. ` +
              `You can only access files within: ${allowedDirs.join(", ")}`
            );
          }
        }

        if (tool === "grep" || tool === "glob") {
          const searchPath = (input.args.path || input.args.directory) as string | undefined;
          if (searchPath && !isPathAllowed(searchPath, allowedDirs)) {
            throw new Error(
              `Access denied: \`${searchPath}\` is outside the allowed repositories. ` +
              `You can only search within: ${allowedDirs.join(", ")}`
            );
          }
        }

        // Check bash commands for absolute paths
        if (tool === "bash") {
          const command = input.args.command as string | undefined;
          if (command && BASH_PATH_COMMANDS.test(command)) {
            const paths = extractPathsFromBash(command);
            for (const p of paths) {
              if (!isPathAllowed(p, allowedDirs)) {
                throw new Error(
                  `Access denied: bash command references \`${p}\` which is outside the allowed repositories. ` +
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
