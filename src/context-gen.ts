import {
  createOpencodeClient,
  type Event,
} from "@opencode-ai/sdk";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { getClient, createSession, getBaseUrl } from "./opencode.js";

// Path to the repo directory (where OpenCode server runs)
const REPO_DIR = process.env.REPO_DIR || "/app/repo";
const CONTEXT_SHA_FILE = path.join(REPO_DIR, ".opencode/rules/.context-sha");

const CONTEXT_FILES = [
  ".opencode/rules/repo-overview.md",
  ".opencode/rules/directory-map.md",
  ".opencode/rules/key-abstractions.md",
  ".opencode/rules/conventions.md",
];

/**
 * Get the current HEAD SHA of the repo.
 */
function getHeadSha(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_DIR, encoding: "utf-8" }).trim();
}

/**
 * Get the SHA from the last successful context generation, or null if none.
 */
function getLastContextSha(): string | null {
  try {
    if (existsSync(CONTEXT_SHA_FILE)) {
      return readFileSync(CONTEXT_SHA_FILE, "utf-8").trim();
    }
  } catch {
    // File doesn't exist or isn't readable
  }
  return null;
}

/**
 * Save the current HEAD SHA as the last context generation point.
 */
function saveContextSha(sha: string): void {
  writeFileSync(CONTEXT_SHA_FILE, sha + "\n", "utf-8");
}

/**
 * Check if the context files already exist (i.e. a full generation has run before).
 */
function contextFilesExist(): boolean {
  return CONTEXT_FILES.every((f) => existsSync(path.join(REPO_DIR, f)));
}

/**
 * Get the git log and diffstat between two SHAs.
 */
function getChangesSince(fromSha: string): { log: string; diffstat: string } {
  const log = execFileSync("git", ["log", "--oneline", `${fromSha}..HEAD`], {
    cwd: REPO_DIR,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  }).trim();

  const diffstat = execFileSync("git", ["diff", "--stat", `${fromSha}..HEAD`], {
    cwd: REPO_DIR,
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  }).trim();

  return { log, diffstat };
}

/**
 * Read the current contents of all context files.
 */
function readCurrentContextFiles(): string {
  return CONTEXT_FILES.map((f) => {
    const fullPath = path.join(REPO_DIR, f);
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
  return `You are a codebase analyst. Your job is to explore the ${repoName} repository and write reference documentation files that will be used as context by a Q&A assistant.

Explore the repository thoroughly — look at the directory structure, key config files (package.json, Pipfile, pyproject.toml, go.mod, Cargo.toml, Gemfile, Dockerfile, etc.), important source directories, and recent git history.

Then write the following 4 files using the write tool. Each file should be concise, accurate, and useful for someone answering questions about this codebase.

## File 1: .opencode/rules/repo-overview.md

A high-level overview:
- What the project is and what it does (infer from README, config files, and code structure)
- Tech stack (languages, frameworks, databases, infrastructure — only what you can confirm exists)
- Top-level directory layout with brief descriptions of what each directory contains

## File 2: .opencode/rules/directory-map.md

A navigational map of the most important directories, showing their internal structure (1-2 levels deep). Focus on directories that contain business logic, API definitions, data models, and configuration. Skip boilerplate directories (node_modules, dist, build, migrations, __pycache__).

## File 3: .opencode/rules/key-abstractions.md

An inventory of the key domain abstractions:
- Data models / entities (with file paths and class/struct/type names)
- API endpoints / routes (with file paths)
- Service layers / business logic modules
- Background jobs / async tasks
- Configuration systems
Only include what actually exists. Cite file paths.

## File 4: .opencode/rules/conventions.md

Patterns and conventions used in the codebase:
- File organization patterns (how code is structured within modules/packages)
- Naming conventions
- Testing patterns and test file locations
- Configuration file locations
- Any monorepo/workspace structure
- Recently active areas (use git log to find the most-changed files in the last 100 commits)

IMPORTANT:
- Only document what you can actually verify exists in the repo. Do NOT guess or hallucinate.
- Be concise. Each file should be useful as quick reference, not exhaustive documentation.
- Use markdown formatting with headers, tables, and code blocks.
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

If a file needs updates, rewrite it with the write tool. If a file is still accurate, skip it — do NOT rewrite files that don't need changes.

If the changes are minor (e.g. bug fixes, test updates, documentation tweaks) and don't affect the codebase structure or conventions, it's fine to skip all files. Just say "No context updates needed" and stop.

IMPORTANT:
- Only document what you can actually verify exists in the repo. Do NOT guess or hallucinate.
- You can use bash, read, grep, glob to inspect the repo if needed to verify changes.
- Be concise. Each file should be useful as quick reference, not exhaustive documentation.
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
export async function generateContext(): Promise<void> {
  const repoName = process.env.TARGET_REPO || "the target repository";
  const currentSha = getHeadSha();
  const lastSha = getLastContextSha();
  const hasContextFiles = contextFilesExist();

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
    const { log, diffstat } = getChangesSince(lastSha);
    if (!log) {
      console.log(`[context-gen] No commits found between ${lastSha.slice(0, 8)} and ${currentSha.slice(0, 8)}. Skipping.`);
      saveContextSha(currentSha);
      return;
    }
    const currentContext = readCurrentContextFiles();
    prompt = buildIncrementalPrompt(repoName, log, diffstat, currentContext);
    console.log(`[context-gen] Starting incremental context update (${lastSha.slice(0, 8)}..${currentSha.slice(0, 8)})...`);
  }

  // Create a session and fire the prompt
  const sessionId = await createSession(`Context ${mode}: ${repoName}`);
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
  saveContextSha(currentSha);
  console.log(`[context-gen] Context generation complete (${mode}, sha: ${currentSha.slice(0, 8)}).`);
}
