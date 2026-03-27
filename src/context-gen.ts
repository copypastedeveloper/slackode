import {
  createOpencodeClient,
  type Event,
} from "@opencode-ai/sdk";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { getClient, createSession, getBaseUrl, autoAllowPermission } from "./opencode.js";

const CONTEXT_FILE_NAMES = [
  ".opencode/rules/repo-overview.md",
  ".opencode/rules/directory-map.md",
  ".opencode/rules/key-abstractions.md",
  ".opencode/rules/conventions.md",
];

/**
 * Get the current HEAD SHA of the repo.
 */
function getHeadSha(repoDir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" }).trim();
}

/**
 * Get the SHA from the last successful context generation, or null if none.
 */
function getLastContextSha(repoDir: string): string | null {
  const shaFile = path.join(repoDir, ".opencode/rules/.context-sha");
  try {
    if (existsSync(shaFile)) {
      return readFileSync(shaFile, "utf-8").trim();
    }
  } catch {
    // File doesn't exist or isn't readable
  }
  return null;
}

/**
 * Save the current HEAD SHA as the last context generation point.
 */
function saveContextSha(repoDir: string, sha: string): void {
  const shaFile = path.join(repoDir, ".opencode/rules/.context-sha");
  writeFileSync(shaFile, sha + "\n", "utf-8");
}

/**
 * Check if the context files already exist (i.e. a full generation has run before).
 */
function contextFilesExist(repoDir: string): boolean {
  return CONTEXT_FILE_NAMES.every((f) => existsSync(path.join(repoDir, f)));
}

/**
 * Get the git log and diffstat between two SHAs.
 */
function getChangesSince(repoDir: string, fromSha: string): { log: string; diffstat: string } {
  const log = execFileSync("git", ["log", "--oneline", `${fromSha}..HEAD`], {
    cwd: repoDir,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  }).trim();

  const diffstat = execFileSync("git", ["diff", "--stat", `${fromSha}..HEAD`], {
    cwd: repoDir,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  }).trim();

  return { log, diffstat };
}

/**
 * Read only the repo-overview.md for a given repo directory.
 * Returns the content string or null if missing/unreadable.
 */
export function readRepoOverview(repoDir: string): string | null {
  const overviewPath = path.join(repoDir, ".opencode/rules/repo-overview.md");
  try {
    return readFileSync(overviewPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read the current contents of all context files for a given repo directory.
 * Exported so that the OpenCode client can include non-default repo context in prompts.
 */
export function readRepoContextFiles(repoDir: string): string {
  return CONTEXT_FILE_NAMES.map((f) => {
    const fullPath = path.join(repoDir, f);
    try {
      const content = readFileSync(fullPath, "utf-8");
      return `### ${f}\n\`\`\`markdown\n${content}\n\`\`\``;
    } catch {
      return `### ${f}\n(file not found)`;
    }
  }).join("\n\n");
}

/**
 * Build the prompt for a full context generation (first run).
 */
function buildFullGenPrompt(repoName: string): string {
  return `You are a codebase analyst. Explore the ${repoName} repository and write 4 concise reference documentation files.

Look at directory structure, config files, key source directories, and recent git history. Then write the following files using the write tool.

## File 1: .opencode/rules/repo-overview.md (target: 80-120 lines)

- What the project is and does
- Tech stack (languages, frameworks, databases — only confirmed)
- Top-level directory layout with brief descriptions

## File 2: .opencode/rules/directory-map.md (target: 100-200 lines)

Navigational map of important directories, 1-2 levels deep. Focus on business logic, APIs, data models, config. Skip node_modules, dist, build, migrations, __pycache__.

## File 3: .opencode/rules/key-abstractions.md (target: 100-200 lines)

Key domain abstractions with file paths:
- Data models / entities (top 20-30 most important, not exhaustive)
- API endpoints / route files (list the route modules, not every endpoint)
- Major service layers / business logic modules
- Background jobs / async tasks
Only include what exists. Cite file paths. Prioritize breadth over depth — a Q&A agent can always read files for detail.

## File 4: .opencode/rules/conventions.md (target: 80-150 lines)

- File organization patterns
- Naming conventions
- Testing patterns and test file locations
- Configuration file locations
- Monorepo/workspace structure
- Top 10 most-changed files from last 100 commits

CRITICAL RULES:
- Each file MUST be under 250 lines. Aim for the target line counts above.
- Only document what you can verify. Do NOT guess or hallucinate.
- These files are quick-reference guides, not exhaustive documentation. The Q&A agent can read source files for details.
- Use markdown formatting. Be terse — tables are preferred over prose.
- Write all 4 files, then stop.`;
}

/**
 * Build the prompt for an incremental context update.
 */
function buildIncrementalPrompt(
  repoName: string,
  log: string,
  diffstat: string,
  currentContext: string
): string {
  return `You are a codebase analyst maintaining reference documentation for the ${repoName} repository. The documentation is used as context by a Q&A assistant.

The repo has been updated. Here are the new commits since the last context generation:

## Commit log
\`\`\`
${log}
\`\`\`

## Changed files (diffstat)
\`\`\`
${diffstat}
\`\`\`

## Current context files

${currentContext}

## Your task

Review the commits and changes above. Determine whether any of the 4 context files need to be updated to reflect the changes. Consider:

- New directories or modules added
- Removed or renamed directories/files
- New models, API endpoints, services, or background tasks
- Tech stack changes (new dependencies, frameworks)
- Structural changes to the codebase organization
- Shifts in which areas are most actively developed

If a file needs updates, rewrite it completely with the write tool (do not use edit/patch — write the whole file). If a file is still accurate, skip it.

If the changes are minor (bug fixes, test updates, documentation tweaks) and don't affect structure or conventions, say "No context updates needed" and stop.

CRITICAL RULES:
- Each file MUST be under 250 lines. If a file is currently over 250 lines, rewrite it shorter even if the content hasn't changed.
- Only document what you can verify. Do NOT guess or hallucinate.
- These are quick-reference guides, not exhaustive documentation.
- Write only the files that need updating, then stop.`;
}

/**
 * Extract the tool state type from a Part's state object.
 */
function getToolStateType(part: { state?: unknown }): string | undefined {
  return part.state && typeof part.state === "object" && "type" in part.state
    ? (part.state as { type: string }).type
    : undefined;
}

/**
 * Run context generation using the "context" agent.
 * - First run: full analysis of the repo, writes all 4 context files.
 * - Subsequent runs: incremental update based on commits since last generation.
 * - Skips entirely if there are no new commits.
 *
 * Called on startup and every hour.
 */
export async function generateContext(repoDir: string, repoName: string): Promise<void> {
  const currentSha = getHeadSha(repoDir);
  const lastSha = getLastContextSha(repoDir);
  const hasContextFiles = contextFilesExist(repoDir);

  // Determine if this is a full gen or incremental update
  let prompt: string;
  let mode: string;

  if (!hasContextFiles || !lastSha) {
    // First run or context files are missing — full generation
    mode = "full";
    prompt = buildFullGenPrompt(repoName);
    console.log(`[context-gen] Starting full context generation (no prior context found)...`);
  } else if (lastSha === currentSha) {
    // No new commits — skip entirely
    console.log(`[context-gen] No new commits since last generation (${currentSha.slice(0, 8)}). Skipping.`);
    return;
  } else {
    // Incremental update
    mode = "incremental";
    const { log, diffstat } = getChangesSince(repoDir, lastSha);
    if (!log) {
      console.log(`[context-gen] No commits found between ${lastSha.slice(0, 8)} and ${currentSha.slice(0, 8)}. Skipping.`);
      saveContextSha(repoDir, currentSha);
      return;
    }
    const currentContext = readRepoContextFiles(repoDir);
    prompt = buildIncrementalPrompt(repoName, log, diffstat, currentContext);
    console.log(`[context-gen] Starting incremental context update (${lastSha.slice(0, 8)}..${currentSha.slice(0, 8)})...`);
  }

  // Create a session in the target repo's directory
  const sessionId = await createSession(`Context ${mode}: ${repoName}`, repoDir);
  console.log(`[context-gen] Session created: ${sessionId}`);

  // Subscribe to SSE BEFORE sending the prompt
  const sseClient = createOpencodeClient({ baseUrl: getBaseUrl() });
  const subscription = await sseClient.event.subscribe();
  const stream = subscription.stream;

  await getClient().session.promptAsync({
    path: { id: sessionId },
    body: {
      agent: "context",
      parts: [{ type: "text", text: prompt }],
    },
  });

  // Wait for completion
  let done = false;
  const TIMEOUT_MS = 15 * 60 * 1000;
  const timeout = setTimeout(() => { done = true; }, TIMEOUT_MS);

  try {
    for await (const event of stream) {
      if (done) break;
      const evt = event as Event;

      if (evt.type === "session.idle" && evt.properties.sessionID === sessionId) {
        done = true;
        break;
      }

      if (evt.type === "permission.updated") {
        const perm = evt.properties;
        if (perm.sessionID === sessionId) {
          await autoAllowPermission(sseClient, sessionId, perm, "context-gen");
        }
      }

      if (evt.type === "message.part.updated") {
        const { part } = evt.properties;
        if (part.sessionID !== sessionId) continue;
        if (part.type === "tool") {
          const stateType = getToolStateType(part);
          if (stateType === "running") {
            console.log(`[context-gen] Running tool: ${part.tool}`);
          }
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    stream.return(undefined);
  }

  // Save the SHA so the next run knows where to diff from
  saveContextSha(repoDir, currentSha);
  console.log(`[context-gen] Context generation complete (${mode}, sha: ${currentSha.slice(0, 8)}).`);
}
