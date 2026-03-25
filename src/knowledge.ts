/**
 * S3-compatible knowledge file sync.
 *
 * Syncs markdown files from an S3 bucket to `/app/knowledge/` on disk.
 * Files are organized by scope:
 *   global/company.md              → always available
 *   global/coding-standards.md     → available for coding sessions
 *   repos/{repo-name}/guidelines.md → per-repo knowledge
 *   channels/{channel-name}/context.md → per-channel knowledge
 */
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  type _Object,
} from "@aws-sdk/client-s3";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, rmdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR ?? "/app/knowledge";
const KNOWLEDGE_BUCKET = process.env.KNOWLEDGE_BUCKET;
const KNOWLEDGE_ENDPOINT = process.env.KNOWLEDGE_ENDPOINT;
const KNOWLEDGE_PREFIX = process.env.KNOWLEDGE_PREFIX ?? "";
const KNOWLEDGE_SYNC_INTERVAL_MS = Number(process.env.KNOWLEDGE_SYNC_INTERVAL_MS) || 30 * 60 * 1000;

const MAX_GLOBAL_CHARS = 2000;
const MAX_REPO_CHARS = 1500;
const MAX_CHANNEL_CHARS = 1000;

function getS3Client(): S3Client | null {
  if (!KNOWLEDGE_BUCKET) return null;
  return new S3Client({
    ...(KNOWLEDGE_ENDPOINT ? { endpoint: KNOWLEDGE_ENDPOINT, forcePathStyle: true } : {}),
    ...(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}),
  });
}

/**
 * Sync knowledge files from S3 to local disk.
 * Downloads newer files, deletes removed ones.
 * Never throws — logs errors and continues.
 */
export async function syncKnowledge(): Promise<void> {
  const s3 = getS3Client();
  if (!s3) {
    console.log("[knowledge] No KNOWLEDGE_BUCKET configured, skipping sync.");
    return;
  }

  console.log(`[knowledge] Syncing from s3://${KNOWLEDGE_BUCKET}/${KNOWLEDGE_PREFIX}...`);

  try {
    // List all objects in the bucket
    const remoteKeys = new Set<string>();
    let continuationToken: string | undefined;

    do {
      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: KNOWLEDGE_BUCKET,
        Prefix: KNOWLEDGE_PREFIX || undefined,
        ContinuationToken: continuationToken,
      }));

      for (const obj of resp.Contents ?? []) {
        if (!obj.Key || !obj.Key.endsWith(".md")) continue;

        const relKey = KNOWLEDGE_PREFIX
          ? obj.Key.slice(KNOWLEDGE_PREFIX.length).replace(/^\//, "")
          : obj.Key;

        remoteKeys.add(relKey);
        await downloadIfNewer(s3, obj.Key, relKey, obj.LastModified);
      }

      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);

    // Delete local files that no longer exist in S3
    cleanupRemovedFiles(KNOWLEDGE_DIR, "", remoteKeys);

    console.log(`[knowledge] Sync complete (${remoteKeys.size} files).`);
  } catch (err) {
    console.error("[knowledge] Sync failed:", err);
  }
}

async function downloadIfNewer(
  s3: S3Client,
  s3Key: string,
  relPath: string,
  remoteModified?: Date,
): Promise<void> {
  const localPath = path.join(KNOWLEDGE_DIR, relPath);
  const localDir = path.dirname(localPath);

  // Check if local file is already up to date
  if (remoteModified && existsSync(localPath)) {
    const localStat = statSync(localPath);
    if (localStat.mtimeMs >= remoteModified.getTime()) return;
  }

  try {
    const resp = await s3.send(new GetObjectCommand({
      Bucket: KNOWLEDGE_BUCKET,
      Key: s3Key,
    }));

    const body = await resp.Body?.transformToString();
    if (!body) return;

    mkdirSync(localDir, { recursive: true });
    writeFileSync(localPath, body, "utf-8");
    console.log(`[knowledge] Downloaded: ${relPath}`);
  } catch (err) {
    console.error(`[knowledge] Failed to download ${s3Key}:`, err);
  }
}

function cleanupRemovedFiles(dir: string, prefix: string, remoteKeys: Set<string>): void {
  if (!existsSync(dir)) return;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      cleanupRemovedFiles(fullPath, relPath, remoteKeys);
      // Remove empty directories
      try {
        const remaining = readdirSync(fullPath);
        if (remaining.length === 0) rmdirSync(fullPath);
      } catch { /* ignore */ }
    } else if (entry.name.endsWith(".md") && !remoteKeys.has(relPath)) {
      unlinkSync(fullPath);
      console.log(`[knowledge] Removed: ${relPath}`);
    }
  }
}

/**
 * Read and concatenate all markdown files in a scope directory.
 */
function readScopeFiles(scope: string, maxChars: number): string {
  const dir = path.join(KNOWLEDGE_DIR, scope);
  if (!existsSync(dir)) return "";

  const parts: string[] = [];
  let totalLen = 0;

  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    for (const file of files) {
      const content = readFileSync(path.join(dir, file), "utf-8").trim();
      if (!content) continue;

      if (totalLen + content.length > maxChars) {
        const remaining = maxChars - totalLen;
        if (remaining > 100) {
          parts.push(content.slice(0, remaining) + "\n[...truncated]");
        }
        break;
      }

      parts.push(content);
      totalLen += content.length;
    }
  } catch {
    // Directory read failed — return empty
  }

  return parts.join("\n\n");
}

/** Read all global knowledge files. */
export function getGlobalKnowledge(): string {
  return readScopeFiles("global", MAX_GLOBAL_CHARS);
}

/** Read repo-specific knowledge files. */
export function getRepoKnowledge(repoName: string): string {
  return readScopeFiles(`repos/${repoName}`, MAX_REPO_CHARS);
}

/** Read channel-specific knowledge files. */
export function getChannelKnowledge(channelName: string): string {
  return readScopeFiles(`channels/${channelName}`, MAX_CHANNEL_CHARS);
}

/** Start periodic knowledge sync. Returns the interval for cleanup. */
export function startKnowledgeSync(): NodeJS.Timeout | null {
  if (!KNOWLEDGE_BUCKET) {
    console.log("[knowledge] No KNOWLEDGE_BUCKET configured, periodic sync disabled.");
    return null;
  }

  console.log(`[knowledge] Starting periodic sync every ${KNOWLEDGE_SYNC_INTERVAL_MS / 60000} min.`);
  return setInterval(() => {
    syncKnowledge().catch((err) => console.error("[knowledge] Periodic sync error:", err));
  }, KNOWLEDGE_SYNC_INTERVAL_MS);
}
