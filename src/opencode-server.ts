import { spawn, type ChildProcess } from "node:child_process";
import { writeOpencodeConfig } from "./opencode-config.js";

const PORT = 4096;
const HOSTNAME = "127.0.0.1";
const HEALTH_URL = `http://${HOSTNAME}:${PORT}/global/health`;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 1_000;

let serverProcess: ChildProcess | null = null;
let restarting = false;
let repoDir: string;

/**
 * Check if the OpenCode server is currently restarting.
 * Used by handleQuestion to show a "reconfiguring" message.
 */
export function isRestarting(): boolean {
  return restarting;
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
  });

  serverProcess.on("error", (err) => {
    console.error("[server] Failed to start OpenCode:", err);
  });

  serverProcess.on("exit", (code, signal) => {
    console.log(`[server] OpenCode exited (code=${code}, signal=${signal})`);
    serverProcess = null;
  });

  // Poll health endpoint until ready
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    try {
      const resp = await fetch(HEALTH_URL, {
        signal: AbortSignal.timeout(2_000),
      });
      if (resp.ok) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`[server] OpenCode server is ready (took ${elapsed}s).`);
        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }

  throw new Error(`OpenCode server failed to start within ${HEALTH_TIMEOUT_MS / 1000}s`);
}

/**
 * Gracefully stop the OpenCode server.
 */
export async function stopServer(): Promise<void> {
  if (!serverProcess) return;

  console.log("[server] Stopping OpenCode server...");
  const proc = serverProcess;
  serverProcess = null;

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      console.warn("[server] Force killing OpenCode server (SIGKILL).");
      proc.kill("SIGKILL");
      resolve();
    }, 10_000);

    proc.once("exit", () => {
      clearTimeout(timeout);
      console.log("[server] OpenCode server stopped.");
      resolve();
    });

    proc.kill("SIGTERM");
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
  }
}
