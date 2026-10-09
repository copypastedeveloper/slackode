/**
 * Keep opencode's SQLite database on local disk, with EFS as the backup.
 *
 * opencode.db (~1GB) used to live on the EFS mount with the rest of the
 * opencode data dir. Every agent step reads and writes it, so any NFS
 * slowness — a host whose network allowance is exhausted, a saturated mount —
 * stalled every step of every turn (observed 2026-10-08: 175 kB/s EFS reads,
 * step times doubled, local tools 0.1s → 0.8s). SQLite also isn't meant to
 * run over NFS.
 *
 * Now opencode runs against a local copy (OPENCODE_DB). At boot the copy is
 * restored from the EFS snapshot; while running, a consistent snapshot is
 * written back to EFS periodically and once more at shutdown. A crash loses at
 * most one interval of conversation history — threads whose session is
 * missing fall back to a fresh session (see getOrCreateSession).
 *
 * Enabled only when OPENCODE_DB_LOCAL is set (the Docker image sets it); local
 * dev keeps opencode's default location.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { copyFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";

const LOCAL_DB = process.env.OPENCODE_DB_LOCAL;
const EFS_DIR = join(homedir(), ".local/share/opencode");
/** Snapshot this module writes. Separate name so it never touches a live legacy DB. */
const SNAPSHOT_DB = join(EFS_DIR, "opencode-snapshot.db");
/** The DB opencode used when it ran directly on EFS. Read once to migrate, never written. */
const LEGACY_DB = join(EFS_DIR, "opencode.db");
const SNAPSHOT_INTERVAL_MS = Number(process.env.OPENCODE_DB_SNAPSHOT_INTERVAL_MS) || 15 * 60 * 1000;
const RESTORE_ATTEMPTS = 3;

let snapshotInterval: ReturnType<typeof setInterval> | undefined;
let snapshotInFlight: Promise<void> | undefined;
/** mtime signature of the DB + WAL at the last snapshot; skip snapshots when unchanged. */
let lastSnapshotSig = "";

export function isLocalDbEnabled(): boolean {
  return !!LOCAL_DB;
}

function mtimeSig(): string {
  const parts = [LOCAL_DB!, `${LOCAL_DB}-wal`].map((p) => {
    try {
      const s = statSync(p);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "-";
    }
  });
  return parts.join("|");
}

function removeDbFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
}

/** Copy `source` (plus its WAL, if asked) to the local path and verify it opens cleanly. */
function tryRestore(source: string, withWal: boolean): boolean {
  removeDbFiles(LOCAL_DB!);
  copyFileSync(source, LOCAL_DB!);
  if (withWal && existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${LOCAL_DB}-wal`);

  const db = new Database(LOCAL_DB!, { fileMustExist: true });
  try {
    // Fold any copied WAL into the main file so the local DB starts self-contained.
    db.pragma("wal_checkpoint(TRUNCATE)");
    const result = db.pragma("quick_check", { simple: true });
    if (result !== "ok") {
      console.error(`[opencode-db] quick_check failed for copy of ${source}: ${String(result)}`);
      return false;
    }
    return true;
  } finally {
    db.close();
  }
}

/**
 * Restore the local opencode DB from EFS and point opencode at it via
 * OPENCODE_DB. Must run before the OpenCode server starts. Never throws: on
 * failure opencode starts with an empty DB, which costs thread history but
 * keeps the bot up.
 */
export function restoreOpencodeDb(): void {
  if (!LOCAL_DB) return;
  mkdirSync(dirname(LOCAL_DB), { recursive: true });
  process.env.OPENCODE_DB = LOCAL_DB;

  if (existsSync(LOCAL_DB)) {
    console.log(`[opencode-db] Local DB already present at ${LOCAL_DB}; keeping it.`);
    return;
  }

  // Prefer our own snapshot. Fall back to the legacy live DB once, for the
  // migration off EFS — it may still be written by an old task during a
  // rolling deploy, so the copy is checked and retried.
  const source = existsSync(SNAPSHOT_DB) ? SNAPSHOT_DB : existsSync(LEGACY_DB) ? LEGACY_DB : undefined;
  if (!source) {
    console.log("[opencode-db] No EFS snapshot or legacy DB found; opencode will start with an empty DB.");
    return;
  }

  const started = Date.now();
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt++) {
    try {
      if (tryRestore(source, source === LEGACY_DB)) {
        const mb = (statSync(LOCAL_DB).size / 1e6).toFixed(0);
        console.log(`[opencode-db] Restored ${mb}MB from ${source} to ${LOCAL_DB} in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
        lastSnapshotSig = mtimeSig();
        return;
      }
    } catch (err) {
      console.error(`[opencode-db] Restore attempt ${attempt} from ${source} failed:`, err);
    }
  }
  console.error(`[opencode-db] Could not restore a valid copy of ${source}; starting with an empty DB. Thread history is lost.`);
  removeDbFiles(LOCAL_DB);
}

/** Atomically replace the EFS snapshot with a local file. */
async function publishSnapshot(localFile: string): Promise<void> {
  const tmp = `${SNAPSHOT_DB}.tmp`;
  await copyFile(localFile, tmp);
  await rename(tmp, SNAPSHOT_DB);
}

function vacuumInto(dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./opencode-db-snapshot-worker.js", import.meta.url), {
      workerData: { source: LOCAL_DB, dest },
    });
    worker.once("message", (msg: { ok: boolean; error?: string }) => {
      if (msg.ok) resolve();
      else reject(new Error(msg.error));
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`snapshot worker exited with code ${code}`));
    });
  });
}

/** Snapshot the live DB to EFS without blocking the event loop. */
export function snapshotOpencodeDb(): Promise<void> {
  if (!LOCAL_DB || !existsSync(LOCAL_DB)) return Promise.resolve();
  if (snapshotInFlight) return snapshotInFlight;

  const sig = mtimeSig();
  if (sig === lastSnapshotSig) return Promise.resolve();

  const localSnap = `${LOCAL_DB}.snap`;
  snapshotInFlight = (async () => {
    const started = Date.now();
    try {
      await rm(localSnap, { force: true });
      await vacuumInto(localSnap);
      await publishSnapshot(localSnap);
      lastSnapshotSig = sig;
      console.log(`[opencode-db] Snapshot to EFS done in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
    } catch (err) {
      console.error("[opencode-db] Snapshot failed:", err);
    } finally {
      await rm(localSnap, { force: true }).catch(() => {});
      snapshotInFlight = undefined;
    }
  })();
  return snapshotInFlight;
}

/**
 * Final snapshot at shutdown, after the OpenCode server has stopped. With no
 * writer left, checkpointing and copying the file is much faster than
 * VACUUM INTO, which matters inside ECS's stop timeout.
 */
export async function finalSnapshotOpencodeDb(): Promise<void> {
  if (!LOCAL_DB || !existsSync(LOCAL_DB)) return;
  if (snapshotInFlight) await snapshotInFlight;
  if (mtimeSig() === lastSnapshotSig) {
    console.log("[opencode-db] No changes since last snapshot; skipping final snapshot.");
    return;
  }
  const started = Date.now();
  try {
    const db = new Database(LOCAL_DB, { fileMustExist: true });
    try {
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    await publishSnapshot(LOCAL_DB);
    console.log(`[opencode-db] Final snapshot to EFS done in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
  } catch (err) {
    console.error("[opencode-db] Final snapshot failed:", err);
  }
}

export function startPeriodicOpencodeDbSnapshot(): void {
  if (!LOCAL_DB || snapshotInterval) return;
  snapshotInterval = setInterval(() => { void snapshotOpencodeDb(); }, SNAPSHOT_INTERVAL_MS);
  console.log(`[opencode-db] Periodic snapshot every ${Math.round(SNAPSHOT_INTERVAL_MS / 60000)} min.`);
}

export function stopPeriodicOpencodeDbSnapshot(): void {
  if (snapshotInterval) clearInterval(snapshotInterval);
  snapshotInterval = undefined;
}
