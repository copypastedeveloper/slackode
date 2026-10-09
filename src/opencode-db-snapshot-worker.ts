/**
 * Worker thread for snapshotting the live opencode.db. VACUUM INTO is
 * synchronous in better-sqlite3 and takes seconds on a ~1GB database, so it
 * runs here instead of blocking the bot's event loop.
 */
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";

const { source, dest } = workerData as { source: string; dest: string };

try {
  const db = new Database(source, { fileMustExist: true });
  try {
    db.pragma("busy_timeout = 30000");
    // Produces a consistent, WAL-free copy while opencode keeps writing.
    db.prepare("VACUUM INTO ?").run(dest);
  } finally {
    db.close();
  }
  parentPort?.postMessage({ ok: true });
} catch (err) {
  parentPort?.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
