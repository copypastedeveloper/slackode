import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import {
  createOpencodeClient,
  type OpencodeClient,
} from "@opencode-ai/sdk";
import {
  getCodingSession, saveCodingSession, updateCodingSessionStatus,
  updateCodingSessionOpencode, touchCodingSession, deleteCodingSession,
  getActiveCodingSessions, getIdleCodingSessions, getEnabledRepos,
  getRepo, SessionStatus, getUserGithubPAT,
  type CodingSessionRow,
} from "./sessions.js";
import { writeOpencodeConfig } from "./opencode-config.js";
import {
  HOSTNAME, CODING_BASE_PORT,
  BOT_MANAGED_PATHS, INTERNAL_AGENT_NAMES, INTERNAL_AGENT_PREFIX,
  REQUEST_TIMEOUT_MS, waitForHealth,
} from "./constants.js";
import { resolveRepoForChannel } from "./repo-manager.js";
import { writeSkillManifest } from "./skill-manifest.js";
import {
  askQuestion, buildCodingContextPrefix, buildPlanningContextPrefix,
  type AskResult, type ProgressCallback,
} from "./opencode.js";
import { buildPrefix } from "./context-prefix.js";
import type { SlackContext } from "./utils/slack-context.js";
import type { ConvertedFile } from "./utils/slack-files.js";

const MAX_CODING_SESSIONS = parseInt(process.env.MAX_CODING_SESSIONS ?? "10", 10);
const IDLE_TIMEOUT_SECONDS = 30 * 60; // 30 minutes
const REAPER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const BASE_PORT = CODING_BASE_PORT;

// ── Port allocation ──
// Ports increment and wrap around, but skip any that are still actively in use.

const MAX_PORT = BASE_PORT + 100;
const usedPorts = new Set<number>();
let nextPort = BASE_PORT;

function allocatePort(): number {
  const startPort = nextPort;
  do {
    const port = nextPort;
    nextPort = nextPort + 1 >= MAX_PORT ? BASE_PORT : nextPort + 1;
    if (!usedPorts.has(port)) {
      usedPorts.add(port);
      return port;
    }
  } while (nextPort !== startPort);
  throw new Error("No available ports for coding sessions");
}

function freePort(port: number): void {
  usedPorts.delete(port);
}

// ── Server process tracking ──

const serverProcesses = new Map<string, ChildProcess>(); // threadKey -> process
const sessionClients = new Map<string, OpencodeClient>(); // threadKey -> client
const sessionAbortControllers = new Map<string, AbortController>(); // threadKey -> abort controller

/**
 * Active coding session info returned to callers.
 */
export interface CodingSession {
  threadKey: string;
  userId: string;
  channelId: string;
  repoName: string;
  branch: string;
  worktreePath: string;
  port: number;
  /** OpenCode agent to use (default "code", or a repo-provided agent name). */
  agent: string;
  status: string;
  client: OpencodeClient;
  opencodeSessionId: string | null;
}

/**
 * Check if a thread has an active coding session.
 */
export function getActiveCodingSession(threadKey: string): CodingSession | undefined {
  const row = getCodingSession(threadKey);
  const liveStatuses: Set<string> = new Set(Object.values(SessionStatus));
  if (!row || !liveStatuses.has(row.status)) return undefined;

  const client = sessionClients.get(threadKey);
  if (!client) return undefined;

  return {
    threadKey: row.thread_key,
    userId: row.user_id,
    channelId: row.channel_id,
    repoName: row.repo_name,
    branch: row.branch,
    worktreePath: row.worktree_path,
    port: row.port,
    agent: row.agent,
    status: row.status,
    client,
    opencodeSessionId: row.opencode_session_id,
  };
}

/**
 * Create a new coding session: worktree + dedicated OpenCode server.
 */
export async function createCodingSession(
  threadKey: string,
  userId: string,
  channelId: string,
  agent: string = "code",
  description?: string,
  repoNameOverride?: string,
): Promise<CodingSession> {
  // Check session limit
  const active = getActiveCodingSessions();
  if (active.length >= MAX_CODING_SESSIONS) {
    throw new Error(
      `Maximum coding sessions reached (${MAX_CODING_SESSIONS}). ` +
      `Use \`done\` or \`cancel\` in an existing coding thread to free up a slot.`
    );
  }

  // Resolve repo: use override if provided, otherwise resolve from channel
  let repoRow;
  if (repoNameOverride) {
    repoRow = getRepo(repoNameOverride);
    if (!repoRow || !repoRow.enabled) {
      throw new Error(`Repository '${repoNameOverride}' not found or disabled.`);
    }
  } else {
    const repoInfo = resolveRepoForChannel(channelId);
    if (!repoInfo) {
      throw new Error("No repository configured for this channel. Use `repo add` first.");
    }
    repoRow = getRepo(repoInfo.name);
    if (!repoRow) {
      throw new Error(`Repository '${repoInfo.name}' not found.`);
    }
  }

  const repoDir = repoRow.dir;

  // Create worktree
  const shortTs = threadKey.replace(".", "-");
  const slug = description
    ? description
        .replace(/<([^|>]+)\|([^>]+)>/g, "$2")  // Slack links: <url|label> → label
        .replace(/<[^>]+>/g, "")                 // Remaining Slack markup
        .replace(/https?:\/\/\S+/gi, "")         // URLs
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 40)
        .replace(/-$/, "")
    : shortTs;
  const branch = `bot/${slug}-${shortTs.slice(-6)}`;
  const worktreeDir = path.join(repoDir, ".worktrees", shortTs);

  // Ensure parent directory exists
  mkdirSync(path.dirname(worktreeDir), { recursive: true });

  // Fetch latest from origin before creating worktree
  try {
    execFileSync("git", ["fetch", "origin"], {
      cwd: repoDir,
      encoding: "utf-8",
      env: process.env,
      timeout: 60_000,
    });
  } catch (err) {
    console.warn(`[coding] git fetch failed for ${repoDir}:`, err);
  }

  // Determine the default branch to base from
  const defaultBranch = getDefaultBranch(repoDir);

  // Create worktree with a new branch based on origin's default branch
  execFileSync(
    "git",
    ["worktree", "add", "-b", branch, worktreeDir, `origin/${defaultBranch}`],
    { cwd: repoDir, encoding: "utf-8", env: process.env, timeout: 30_000 },
  );

  console.log(`[coding] Worktree created: ${worktreeDir} (branch: ${branch})`);

  // Clean repo agents/skills from the worktree (same as main repo)
  cleanWorktreeAgents(worktreeDir);

  // Copy .opencode/rules/ to worktree
  const rulesDir = path.join(worktreeDir, ".opencode/rules");
  mkdirSync(rulesDir, { recursive: true });
  const sourceRules = path.join(repoDir, ".opencode/rules");
  if (existsSync(sourceRules)) {
    try {
      execFileSync("cp", ["-r", sourceRules + "/.", rulesDir], { encoding: "utf-8" });
    } catch {
      // Non-fatal
    }
  }

  try {
    writeSkillManifest(worktreeDir, { allowSkills: repoRow.allow_skills === 1 });
  } catch (err) {
    console.warn(`[coding] Skill manifest gen failed for ${worktreeDir}:`, err);
  }

  // Allocate port and write code-mode config
  const port = allocatePort();
  writeOpencodeConfig(worktreeDir, "code");

  // Save to DB before starting server
  saveCodingSession({
    threadKey,
    userId,
    channelId,
    repoName: repoRow.name,
    branch,
    worktreePath: worktreeDir,
    port,
    agent,
  });

  // Start dedicated OpenCode server
  try {
    await startCodingServer(threadKey, worktreeDir, port);
  } catch (err) {
    // Cleanup on failure
    await destroyCodingSessionInternal(threadKey, worktreeDir, port, repoDir);
    throw err;
  }

  // Create SDK client for this server
  const serverUrl = `http://${HOSTNAME}:${port}`;
  const client = createOpencodeClient({
    baseUrl: serverUrl,
    fetch: (request: Request) =>
      globalThis.fetch(request, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }),
  });
  sessionClients.set(threadKey, client);
  sessionAbortControllers.set(threadKey, new AbortController());

  updateCodingSessionStatus(threadKey, SessionStatus.PLANNING);

  console.log(`[coding] Session active: ${threadKey} on port ${port}`);

  return {
    threadKey,
    userId,
    channelId,
    repoName: repoRow.name,
    branch,
    worktreePath: worktreeDir,
    port,
    agent,
    status: SessionStatus.PLANNING,
    client,
    opencodeSessionId: null,
  };
}

/**
 * Send a question/instruction to a coding session's dedicated OpenCode server.
 */
export async function askCodingQuestion(opts: {
  session: CodingSession;
  question: string;
  ctx: SlackContext;
  onProgress?: ProgressCallback;
  files?: ConvertedFile[];
}): Promise<AskResult> {
  const { session, question, ctx, onProgress, files } = opts;

  touchCodingSession(session.threadKey);

  const serverUrl = `http://${HOSTNAME}:${session.port}`;

  // Create or reuse OpenCode session
  let sessionId = session.opencodeSessionId;
  let isNew = false;

  if (!sessionId) {
    const result = await session.client.session.create({
      body: { title: `Coding: ${session.threadKey}` },
    });
    if (!result.data) {
      throw new Error(`Failed to create coding session: ${JSON.stringify(result.error)}`);
    }
    sessionId = result.data.id;
    updateCodingSessionOpencode(session.threadKey, sessionId);
    session.opencodeSessionId = sessionId;
    isNew = true;
  }

  // Choose context prefix based on phase and agent type:
  // - Planning phase: read-only instructions (investigate + produce plan)
  // - Coding phase (built-in agent): full write instructions
  // - Coding phase (repo agent): minimal prefix (agent's own instructions drive behavior)
  const isBuiltinAgent = session.agent === "code";
  const isPlanning = session.status === SessionStatus.PLANNING;

  let contextPrefix: string;
  if (isPlanning) {
    contextPrefix = isBuiltinAgent
      ? buildPlanningContextPrefix(ctx, isNew, session.repoName, session.worktreePath)
      : buildPrefix({ ctx, isNew, mode: "minimal-planning", repoName: session.repoName });
  } else if (isBuiltinAgent) {
    contextPrefix = buildCodingContextPrefix(ctx, isNew, session.repoName, session.worktreePath);
  } else {
    contextPrefix = buildPrefix({ ctx, isNew, mode: "minimal-coding", repoName: session.repoName });
  }

  const abortController = sessionAbortControllers.get(session.threadKey);

  return askQuestion({
    sessionId,
    question,
    onProgress,
    files,
    agent: session.agent,
    customClient: session.client,
    customBaseUrl: serverUrl,
    customContextPrefix: contextPrefix,
    abortSignal: abortController?.signal,
  });
}

/**
 * Destroy a coding session: kill server, remove worktree, free port.
 */
export async function destroyCodingSession(threadKey: string): Promise<void> {
  const row = getCodingSession(threadKey);
  if (!row) return;

  // Find the parent repo dir (worktree is under repoDir/.worktrees/)
  const repoRow = getRepo(row.repo_name);
  const repoDir = repoRow?.dir ?? path.dirname(path.dirname(row.worktree_path));

  await destroyCodingSessionInternal(threadKey, row.worktree_path, row.port, repoDir);
}

async function destroyCodingSessionInternal(
  threadKey: string,
  worktreePath: string,
  port: number,
  repoDir: string,
): Promise<void> {
  // 1. Abort the local SSE listener so askCodingQuestion throws/exits immediately
  const abort = sessionAbortControllers.get(threadKey);
  if (abort) {
    abort.abort();
    sessionAbortControllers.delete(threadKey);
  }

  // 2. Tell OpenCode to abort the in-flight session (stops the LLM call server-side)
  const sdkClient = sessionClients.get(threadKey);
  const row = getCodingSession(threadKey);
  if (sdkClient && row?.opencode_session_id) {
    try {
      await sdkClient.session.abort({ path: { id: row.opencode_session_id } });
      console.log(`[coding] Session ${threadKey} agent aborted via API.`);
    } catch {
      // Server may already be dead — that's fine
    }
  }

  // 3. Ask the server to shut down gracefully via API
  if (sdkClient) {
    try {
      await sdkClient.instance.dispose();
      console.log(`[coding] Server for ${threadKey} disposed via API.`);
    } catch {
      // Server may already be dead — fall through to process kill
    }
  }

  // 4. Kill server process group as a fallback (handles cases where API didn't work)
  const proc = serverProcesses.get(threadKey);
  if (proc) {
    await killProcess(proc);
    serverProcesses.delete(threadKey);
  }

  // Remove client
  sessionClients.delete(threadKey);

  // Remove worktree
  try {
    if (existsSync(worktreePath)) {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: repoDir,
        encoding: "utf-8",
        timeout: 30_000,
      });
      console.log(`[coding] Worktree removed: ${worktreePath}`);
    }
  } catch (err) {
    console.warn(`[coding] Failed to remove worktree ${worktreePath}:`, err);
    // Try force removing the directory
    try {
      rmSync(worktreePath, { recursive: true, force: true });
      execFileSync("git", ["worktree", "prune"], {
        cwd: repoDir,
        encoding: "utf-8",
        timeout: 10_000,
      });
    } catch {
      // Best effort
    }
  }

  // Clean up empty .worktrees directory so repo sync can resume pulling
  const worktreesDir = path.join(repoDir, ".worktrees");
  try {
    if (existsSync(worktreesDir) && readdirSync(worktreesDir).length === 0) {
      rmSync(worktreesDir, { recursive: true, force: true });
    }
  } catch {
    // Best effort
  }

  // Free port
  freePort(port);

  // Remove from DB
  deleteCodingSession(threadKey);
  console.log(`[coding] Session destroyed: ${threadKey}`);
}

/**
 * Get the diff summary for a coding session's worktree.
 */
export function getCodingSessionDiff(threadKey: string): {
  diffstat: string;
  changedFiles: string[];
} | null {
  const row = getCodingSession(threadKey);
  if (!row) return null;

  try {
    const diffstat = execFileSync("git", ["diff", "--stat", "HEAD"], {
      cwd: row.worktree_path,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();

    const changedFiles = execFileSync(
      "git", ["diff", "--name-only", "HEAD"],
      { cwd: row.worktree_path, encoding: "utf-8", timeout: 10_000 },
    ).trim().split("\n").filter(Boolean);

    // Also check for untracked files
    const untracked = execFileSync(
      "git", ["ls-files", "--others", "--exclude-standard"],
      { cwd: row.worktree_path, encoding: "utf-8", timeout: 10_000 },
    ).trim().split("\n").filter(Boolean);

    return {
      diffstat: diffstat || "(no changes)",
      changedFiles: [...changedFiles, ...untracked],
    };
  } catch (err) {
    console.error(`[coding] Failed to get diff for ${threadKey}:`, err);
    return null;
  }
}

/**
 * Commit, push, and create a draft PR for a coding session.
 * Returns the PR URL on success.
 */
export async function createCodingSessionPR(
  threadKey: string,
  title?: string,
): Promise<{ prUrl: string; diffstat: string; changedFiles: string[] }> {
  const row = getCodingSession(threadKey);
  if (!row) throw new Error("Coding session not found.");

  const cwd = row.worktree_path;

  // Stage all changes except bot configuration files
  execFileSync("git", ["add", "-A"], { cwd, encoding: "utf-8", timeout: 10_000 });
  // Unstage bot-managed files/directories that should never be committed
  for (const managedPath of BOT_MANAGED_PATHS) {
    try {
      execFileSync("git", ["reset", "HEAD", "--", managedPath], { cwd, encoding: "utf-8", timeout: 5_000 });
    } catch {
      // Path may not exist or have no staged changes — that's fine
    }
  }

  // Determine which files are staged for commit (after excluding bot-managed paths)
  const stagedFilesOutput = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd, encoding: "utf-8", timeout: 10_000,
  }).trim();

  if (!stagedFilesOutput) {
    throw new Error("No changes to commit.");
  }

  const changedFiles = stagedFilesOutput.split("\n").filter(Boolean);

  // Get diffstat before commit
  const diffstat = execFileSync("git", ["diff", "--cached", "--stat"], {
    cwd, encoding: "utf-8", timeout: 10_000,
  }).trim();

  // Resolve user's GitHub PAT for commit attribution and push auth
  const userPat = getUserGithubPAT(row.user_id);
  if (!userPat) {
    throw new Error("No GitHub account connected. Run `github connect <pat>` first.");
  }

  // Commit with user's identity
  const commitMessage = title || `bot: changes from coding session ${row.thread_key}`;
  execFileSync("git", ["commit", "-m", commitMessage], {
    cwd, encoding: "utf-8", env: {
      ...process.env,
      GIT_AUTHOR_NAME: userPat.name,
      GIT_AUTHOR_EMAIL: userPat.email,
      GIT_COMMITTER_NAME: userPat.name,
      GIT_COMMITTER_EMAIL: userPat.email,
    },
    timeout: 10_000,
  });

  // Push branch using user's PAT via GIT_ASKPASS
  const shortKey = threadKey.replace(".", "-");
  const askpassPath = `/tmp/git-askpass-${shortKey}.sh`;
  writeFileSync(askpassPath, `#!/bin/sh\necho '${userPat.token}'\n`, { mode: 0o700 });
  try {
    execFileSync("git", ["push", "-u", "origin", row.branch], {
      cwd, encoding: "utf-8",
      env: { ...process.env, GIT_ASKPASS: askpassPath, GIT_TERMINAL_PROMPT: "0" },
      timeout: 60_000,
    });
  } finally {
    try { unlinkSync(askpassPath); } catch { /* best effort */ }
  }

  // Get the full diff for PR description context
  let fullDiff = "";
  try {
    fullDiff = execFileSync("git", ["diff", "HEAD~1"], {
      cwd, encoding: "utf-8", timeout: 10_000,
    }).trim();
  } catch {
    // Fallback if diff fails
  }

  // Ask the coding agent to write a PR description
  let prBody = "";
  const session = getActiveCodingSession(threadKey);
  if (session?.opencodeSessionId && fullDiff) {
    try {
      const serverUrl = `http://${HOSTNAME}:${session.port}`;
      const result = await askQuestion({
        sessionId: session.opencodeSessionId,
        question: "Write a pull request description for the changes you just made. " +
          "Include a '## Summary' section explaining WHAT was changed and WHY. " +
          "Then a '## Changes' section with a bullet list of files and what was done in each. " +
          "Keep it concise. Do NOT include code snippets. Do NOT use tools — just write the description.\n\n" +
          `Diff:\n\`\`\`\n${fullDiff.slice(0, 8000)}\n\`\`\``,
        customClient: session.client,
        customBaseUrl: serverUrl,
        isNewSession: false,
      });
      prBody = result.text.trim();
    } catch (err) {
      console.warn("[coding] Failed to generate PR description:", err);
    }
  }

  // Fallback if agent didn't produce a description
  if (!prBody) {
    prBody = `Automated coding session by <@${row.user_id}>.\n\n**Changed files:**\n${changedFiles.map(f => `- \`${f}\``).join("\n")}\n\n**Diffstat:**\n\`\`\`\n${diffstat}\n\`\`\``;
  }

  const prTitle = title || `[Bot] ${row.branch}`;

  const prUrl = execFileSync(
    "gh",
    ["pr", "create", "--draft", "--title", prTitle, "--body", prBody, "--head", row.branch],
    { cwd, encoding: "utf-8", env: { ...process.env, GH_TOKEN: userPat.token }, timeout: 30_000 },
  ).trim();

  return { prUrl, diffstat, changedFiles };
}

/**
 * Start the idle session reaper. Call once at startup.
 * Returns the interval handle for cleanup.
 */
export function startSessionReaper(): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    const idle = getIdleCodingSessions(IDLE_TIMEOUT_SECONDS);
    for (const session of idle) {
      console.log(`[coding] Reaping idle session: ${session.thread_key} (idle ${Math.round((Date.now() / 1000 - session.last_activity_at) / 60)} min)`);
      try {
        await destroyCodingSession(session.thread_key);
      } catch (err) {
        console.error(`[coding] Failed to reap session ${session.thread_key}:`, err);
      }
    }
  }, REAPER_INTERVAL_MS);
}

/**
 * Destroy all active coding sessions (for shutdown).
 */
export async function destroyAllCodingSessions(): Promise<void> {
  const sessions = getActiveCodingSessions();
  for (const session of sessions) {
    try {
      await destroyCodingSession(session.thread_key);
    } catch (err) {
      console.error(`[coding] Failed to destroy session ${session.thread_key}:`, err);
    }
  }
}

/**
 * Clean up orphaned worktrees and stale DB entries on startup.
 */
export function cleanupOrphanedSessions(): void {
  // Mark any sessions that were "starting" or "active" as destroyed
  // (they can't survive a process restart since the server processes are gone)
  const sessions = getActiveCodingSessions();
  for (const session of sessions) {
    console.log(`[coding] Cleaning up orphaned session: ${session.thread_key}`);
    const repoRow = getRepo(session.repo_name);
    const repoDir = repoRow?.dir ?? path.dirname(path.dirname(session.worktree_path));

    // Try to remove the worktree
    try {
      if (existsSync(session.worktree_path)) {
        execFileSync("git", ["worktree", "remove", "--force", session.worktree_path], {
          cwd: repoDir, encoding: "utf-8", timeout: 30_000,
        });
      }
    } catch {
      try {
        rmSync(session.worktree_path, { recursive: true, force: true });
      } catch {
        // Best effort
      }
    }

    deleteCodingSession(session.thread_key);
  }

  // Prune worktrees on all repos
  for (const repo of getEnabledRepos()) {
    try {
      execFileSync("git", ["worktree", "prune"], {
        cwd: repo.dir, encoding: "utf-8", timeout: 10_000,
      });
    } catch {
      // Best effort
    }
  }
}

/**
 * List available agents for a coding session's server.
 * Queries the dedicated OpenCode server's agent list.
 */
export interface AgentInfo {
  name: string;
  builtIn: boolean;
  description?: string;
}

export async function listCodingAgents(threadKey: string): Promise<AgentInfo[]> {
  const session = getActiveCodingSession(threadKey);
  if (!session) return [];

  try {
    const sdkClient = sessionClients.get(threadKey);
    if (!sdkClient) return [{ name: "code", builtIn: true }];
    const result = await sdkClient.app.agents();
    if (!result.data) return [{ name: "code", builtIn: true }];
    const agents = result.data;
    console.log(`[coding] Agent list for ${threadKey}:`, agents.map((a) => `${a.name}${a.builtIn ? " (built-in)" : ""}`).join(", "));
    return agents
      .filter((a) => !INTERNAL_AGENT_NAMES.has(a.name) && !a.name.startsWith(INTERNAL_AGENT_PREFIX))
      .map((a) => ({ name: a.name, builtIn: a.builtIn, description: a.description }));
  } catch (err) {
    console.warn(`[coding] Failed to list agents for ${threadKey}:`, err);
    return [{ name: "code", builtIn: true }];
  }
}

// ── Internal helpers ──

function getDefaultBranch(repoDir: string): string {
  try {
    const ref = execFileSync(
      "git", ["symbolic-ref", "refs/remotes/origin/HEAD"],
      { cwd: repoDir, encoding: "utf-8", timeout: 5_000 },
    ).trim();
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // Fallback: try common names
    try {
      execFileSync("git", ["rev-parse", "--verify", "origin/main"], {
        cwd: repoDir, encoding: "utf-8", timeout: 5_000,
      });
      return "main";
    } catch {
      return "master";
    }
  }
}

/**
 * Clean only files that conflict with our generated config in coding worktrees.
 *
 * Unlike Q&A (which strips everything), coding worktrees KEEP:
 * - .claude/ (CLAUDE.md project instructions, skills — valuable for coding)
 * - .opencode/agents/ (repo-specific agent definitions)
 * - .agents/ (alternative agent directory)
 *
 * We only remove files that would override the opencode.json we generate:
 * - .opencode/opencode.json / .opencode/.opencode (config overrides)
 * - .opencode/plugin/ (we inject our own repo-scope plugin)
 */
function cleanWorktreeAgents(dir: string): void {
  const dirsToRemove = [
    ".opencode/plugin", ".opencode/plugins",
  ];
  const filesToRemove = [".opencode/opencode.json", ".opencode/.opencode"];

  for (const d of dirsToRemove) {
    const full = path.join(dir, d);
    if (existsSync(full)) rmSync(full, { recursive: true, force: true });
  }
  for (const f of filesToRemove) {
    const full = path.join(dir, f);
    if (existsSync(full)) rmSync(full, { force: true });
  }
}

async function startCodingServer(
  threadKey: string,
  worktreeDir: string,
  port: number,
): Promise<void> {
  console.log(`[coding] Starting server for ${threadKey} on port ${port}...`);

  const proc = spawn(
    "opencode",
    ["serve", "--port", String(port), "--hostname", HOSTNAME],
    { cwd: worktreeDir, stdio: "inherit", env: process.env, detached: true },
  );

  serverProcesses.set(threadKey, proc);

  let exited = false;
  let exitCode: number | null = null;

  proc.on("error", (err) => {
    console.error(`[coding] Server error for ${threadKey}:`, err);
  });

  proc.on("exit", (code, signal) => {
    exited = true;
    exitCode = code;
    console.log(`[coding] Server exited for ${threadKey} (code=${code}, signal=${signal})`);
    serverProcesses.delete(threadKey);
  });

  await waitForHealth({
    url: `http://${HOSTNAME}:${port}/global/health`,
    label: `Coding server (${threadKey})`,
    check: () => {
      if (exited) throw new Error(`Coding server exited during startup (code=${exitCode})`);
    },
  });
}


/**
 * Kill a process and its entire process group (detached spawn).
 * Sends SIGTERM to the group first, escalates to SIGKILL after 10s.
 */
function killProcess(proc: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (proc.exitCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      // Escalate: SIGKILL the process group, then the process directly as fallback
      try { if (proc.pid) process.kill(-proc.pid, "SIGKILL"); } catch { /* already dead */ }
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      resolve();
    }, 10_000);

    proc.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    // Kill the entire process group (negative PID) so child processes die too
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGTERM");
    } catch {
      // If group kill fails, fall back to direct kill
      proc.kill("SIGTERM");
    }
  });
}
