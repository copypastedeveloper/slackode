/**
 * Google Docs sync — discovers docs shared with a GCP service account
 * and upserts them into the knowledge table as global knowledge entries.
 *
 * Requires:
 *   - GOOGLE_APPLICATION_CREDENTIALS env var pointing to a service account JSON key
 *   - Google Drive API + Google Docs API enabled in the GCP project
 */
import { google, type drive_v3 } from "googleapis";
import {
  addKnowledge,
  updateKnowledge,
  getKnowledgeByTitle,
  getAllKnowledgeSources,
  getKnowledgeSource,
  upsertKnowledgeSource,
  removeKnowledgeSource,
} from "./sessions.js";

const SYNC_AUTHOR = "gdocs-sync";
const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

let auth: InstanceType<typeof google.auth.GoogleAuth> | undefined;
let syncInterval: ReturnType<typeof setInterval> | undefined;

function getAuth(): InstanceType<typeof google.auth.GoogleAuth> {
  if (!auth) {
    auth = new google.auth.GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
  }
  return auth;
}

export async function getServiceAccountEmail(): Promise<string> {
  const client = await getAuth().getClient();
  return (client as { email?: string }).email ?? "(unknown)";
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  errors: string[];
}

/**
 * List all Google Docs shared with the service account, handling pagination.
 */
async function listSharedDocs(drive: drive_v3.Drive): Promise<drive_v3.Schema$File[]> {
  const files: drive_v3.Schema$File[] = [];
  let pageToken: string | undefined;
  do {
    const res = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.document'",
      fields: "nextPageToken, files(id, name, modifiedTime)",
      pageSize: 1000,
      ...(pageToken && { pageToken }),
    });
    if (res.data.files) files.push(...res.data.files);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return files;
}

/**
 * Sync all Google Docs shared with the service account into the knowledge table.
 */
export async function syncGoogleDocs(): Promise<SyncResult> {
  const authClient = getAuth();
  const drive = google.drive({ version: "v3", auth: authClient });

  const result: SyncResult = { added: 0, updated: 0, removed: 0, errors: [] };

  // 1. Discover all docs shared with the service account
  let remoteDocs: drive_v3.Schema$File[];
  try {
    remoteDocs = await listSharedDocs(drive);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Failed to list Google Docs: ${msg}`);
    return result;
  }

  const remoteIds = new Set(remoteDocs.map((f) => f.id!));

  // 2. Process each remote doc
  for (const file of remoteDocs) {
    const fileId = file.id!;
    const fileName = file.name ?? "Untitled";
    const modifiedTime = file.modifiedTime ?? new Date().toISOString();

    try {
      const existing = getKnowledgeSource(fileId);

      // Skip if unchanged
      if (existing && existing.modified_time === modifiedTime) {
        continue;
      }

      // Export as plain text (most reliable for Google Docs)
      const exportRes = await drive.files.export({
        fileId,
        mimeType: "text/plain",
      });
      const content = (typeof exportRes.data === "string"
        ? exportRes.data
        : String(exportRes.data)
      ).trim();

      if (!content) {
        result.errors.push(`Skipped empty doc: ${fileName}`);
        continue;
      }

      if (existing) {
        // Update existing knowledge entry
        updateKnowledge(existing.knowledge_id, content, SYNC_AUTHOR);
        upsertKnowledgeSource(fileId, existing.knowledge_id, fileName, modifiedTime);
        result.updated++;
      } else {
        // Check for title collision with manually-created entry
        const collision = getKnowledgeByTitle(fileName, "global", undefined);
        if (collision && collision.created_by !== SYNC_AUTHOR) {
          result.errors.push(
            `Skipped "${fileName}" — conflicts with manually-created knowledge #${collision.id}`,
          );
          continue;
        }

        const knowledgeId = addKnowledge(fileName, content, "global", null, SYNC_AUTHOR);
        upsertKnowledgeSource(fileId, knowledgeId, fileName, modifiedTime);
        result.added++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Failed to sync "${fileName}" (${fileId}): ${msg}`);
    }
  }

  // 3. Remove entries for docs that are no longer shared
  const existingSources = getAllKnowledgeSources();
  for (const source of existingSources) {
    if (!remoteIds.has(source.google_file_id)) {
      removeKnowledgeSource(source.google_file_id);
      result.removed++;
    }
  }

  const parts: string[] = [];
  if (result.added) parts.push(`${result.added} added`);
  if (result.updated) parts.push(`${result.updated} updated`);
  if (result.removed) parts.push(`${result.removed} removed`);
  if (parts.length > 0 || result.errors.length > 0) {
    console.log(`[gdocs-sync] ${parts.join(", ") || "no changes"}${result.errors.length ? ` (${result.errors.length} errors)` : ""}`);
  }
  for (const e of result.errors) {
    console.warn(`[gdocs-sync] ${e}`);
  }

  return result;
}

export function startPeriodicGDocsSync(intervalMs?: number): void {
  if (syncInterval) return;
  const ms = intervalMs ?? (Number(process.env.GDOCS_SYNC_INTERVAL_MS) || DEFAULT_SYNC_INTERVAL_MS);

  // Initial sync after a short delay to avoid blocking startup
  const STARTUP_DELAY_MS = 2 * 60 * 1000; // 2 minutes
  setTimeout(() => {
    syncGoogleDocs().catch((err) => console.error("[gdocs-sync] initial sync failed:", err));
    syncInterval = setInterval(() => {
      syncGoogleDocs().catch((err) => console.error("[gdocs-sync] periodic sync failed:", err));
    }, ms);
  }, STARTUP_DELAY_MS);

  console.log(`[gdocs-sync] Periodic sync scheduled (every ${ms / 1000}s, starting in ${STARTUP_DELAY_MS / 1000}s)`);
}

export function stopPeriodicGDocsSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = undefined;
  }
}
