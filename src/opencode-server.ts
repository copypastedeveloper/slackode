import { spawn, type ChildProcess } from "node:child_process";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { writeOpencodeConfig } from "./opencode-config.js";
import { HOSTNAME, QA_SERVER_PORT, waitForHealth } from "./constants.js";

const PORT = QA_SERVER_PORT;
const HEALTH_URL = `http://${HOSTNAME}:${PORT}/global/health`;

let serverProcess: ChildProcess | null = null;
let restarting = false;
let restartResolvers: Array<() => void> = [];
let repoDir: string;

/**
 * Check if the OpenCode server is currently restarting.
 * Used by handleQuestion to show a "reconfiguring" message.
 */
export function isRestarting(): boolean {
  return restarting;
}

/**
 * Returns a promise that resolves when the current restart completes.
 * Resolves immediately if not currently restarting.
 */
export function waitForRestart(): Promise<void> {
  if (!restarting) return Promise.resolve();
  return new Promise<void>((resolve) => {
    restartResolvers.push(resolve);
  });
}

/**
 * Set the repo directory used for config generation and server cwd.
 */
export function setRepoDir(dir: string): void {
  repoDir = dir;
}

/**
 * Spawn the OpenCode server and wait for it to become healthy.
 */
export async function startServer(): Promise<void> {
  if (!repoDir) throw new Error("setRepoDir() must be called before startServer()");

  console.log("[server] Starting OpenCode server...");
  serverProcess = spawn("opencode", ["serve", "--port", String(PORT), "--hostname", HOSTNAME], {
    cwd: repoDir,
    stdio: "inherit",
    env: process.env,
    detached: true,
  });

  serverProcess.on("error", (err) => {
    console.error("[server] Failed to start OpenCode:", err);
  });

  serverProcess.on("exit", (code, signal) => {
    console.log(`[server] OpenCode exited (code=${code}, signal=${signal})`);
    serverProcess = null;

    // Auto-restart if the server crashed outside of a managed restart/stop.
    if (!restarting) {
      console.warn("[server] Unexpected exit — restarting automatically...");
      startServer().catch((err) => {
        console.error("[server] Auto-restart failed:", err);
      });
    }
  });

  await waitForHealth({ url: HEALTH_URL, label: "OpenCode server" });
}

/**
 * Gracefully stop the OpenCode server.
 */
export async function stopServer(): Promise<void> {
  if (!serverProcess) return;

  console.log("[server] Stopping OpenCode server...");
  const proc = serverProcess;
  serverProcess = null;

  // Try graceful shutdown via API first
  try {
    const client = createOpencodeClient({ baseUrl: `http://${HOSTNAME}:${PORT}` });
    await client.instance.dispose();
    console.log("[server] Dispose request sent.");
  } catch {
    // Server may already be dead — fall through to process kill
  }

  return new Promise<void>((resolve) => {
    // If dispose worked, the process should exit on its own.
    // Give it a few seconds, then escalate.
    const timeout = setTimeout(() => {
      console.warn("[server] Force killing OpenCode server (SIGKILL).");
      try { if (proc.pid) process.kill(-proc.pid, "SIGKILL"); } catch { /* already dead */ }
      try { proc.kill("SIGKILL"); } catch { /* already dead */ }
      resolve();
    }, 10_000);

    proc.once("exit", () => {
      clearTimeout(timeout);
      console.log("[server] OpenCode server stopped.");
      resolve();
    });

    // Also send SIGTERM to the process group as a belt-and-suspenders approach
    try {
      if (proc.pid) process.kill(-proc.pid, "SIGTERM");
    } catch {
      try { proc.kill("SIGTERM"); } catch { /* already dead */ }
    }
  });
}

/**
 * Regenerate opencode.json from DB, then restart the server.
 * Sets the `restarting` flag so in-flight questions get a friendly message.
 * Returns the elapsed time in seconds.
 */
export async function restartServer(): Promise<number> {
  const start = Date.now();
  restarting = true;
  try {
    writeOpencodeConfig(repoDir);
    await stopServer();
    await startServer();
    return (Date.now() - start) / 1000;
  } finally {
    restarting = false;
    for (const resolve of restartResolvers) resolve();
    restartResolvers = [];
  }
}
