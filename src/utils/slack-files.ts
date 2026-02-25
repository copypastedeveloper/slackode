/**
 * Download Slack file attachments and convert to base64 data URIs
 * for passing to OpenCode as FilePartInput.
 */
import type { WebClient } from "@slack/web-api";

export interface SlackFile {
  id?: string;
  url_private: string;
  url_private_download?: string;
  mimetype: string;
  name: string;
  size: number;
  filetype: string;
}

export interface ConvertedFile {
  mime: string;
  filename: string;
  dataUri: string;
  sizeBytes: number;
}

const SUPPORTED_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Filter files to only those we can send to the model (supported MIME + size limit).
 */
function filterSupportedFiles(files: SlackFile[]): SlackFile[] {
  return files.filter((f) => {
    if (!SUPPORTED_MIMES.has(f.mimetype)) {
      console.warn(`Skipping unsupported file type: ${f.name} (${f.mimetype})`);
      return false;
    }
    if (f.size > MAX_FILE_SIZE_BYTES) {
      console.warn(
        `Skipping file too large: ${f.name} (${(f.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB)`
      );
      return false;
    }
    return true;
  });
}

/**
 * Download a single Slack file and return it as a base64 data URI.
 * Slack's url_private requires a bot token for authentication.
 */
async function downloadAsDataUri(file: SlackFile, client: WebClient): Promise<ConvertedFile> {
  // Use files.info to get a fresh, authenticated URL if we have a file ID.
  // The url_private from conversations.replies can be stale or require
  // different auth handling.
  let url = file.url_private_download ?? file.url_private;
  if (file.id) {
    try {
      const info = await client.files.info({ file: file.id });
      if (info.file) {
        const f = info.file as Record<string, unknown>;
        url = (f.url_private_download as string) ?? (f.url_private as string) ?? url;
      }
    } catch (err) {
      console.warn(`files.info failed for ${file.name} (${file.id}), using original URL:`, err);
    }
  }

  console.log(`Downloading file: ${file.name} (${file.mimetype}, ${file.size} bytes)`);

  // Use the WebClient's token for auth. The WebClient exposes the token
  // indirectly — extract it to use with fetch.
  // Slack requires the Bearer token and won't redirect to login if the
  // token has files:read scope.
  const token = (client as unknown as { token: string }).token;

  const authHeaders = { Authorization: `Bearer ${token}` };

  // Node's fetch strips the Authorization header on cross-origin redirects
  // (per the Fetch spec). Slack's file URLs redirect cross-origin.
  // Follow redirects manually to keep the auth header attached.
  let response = await fetch(url, {
    headers: authHeaders,
    redirect: "manual",
  });

  let redirects = 0;
  while ((response.status === 301 || response.status === 302 || response.status === 307 || response.status === 308) && redirects < 5) {
    const location = response.headers.get("location");
    if (!location) break;
    // Re-attach auth header on redirect (fetch strips it cross-origin)
    response = await fetch(location, {
      headers: authHeaders,
      redirect: "manual",
    });
    redirects++;
  }

  if (!response.ok) {
    throw new Error(`Failed to download ${file.name}: HTTP ${response.status} from ${url}`);
  }

  // Sanity check: make sure we got binary data, not an HTML error page
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    throw new Error(`Failed to download ${file.name}: got HTML instead of file data (content-type: ${contentType})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  console.log(`Downloaded ${file.name}: ${buffer.length} bytes`);
  const base64 = buffer.toString("base64");

  return {
    mime: file.mimetype,
    filename: file.name,
    dataUri: `data:${file.mimetype};base64,${base64}`,
    sizeBytes: buffer.length,
  };
}

/**
 * Download all supported Slack file attachments as data URIs.
 * Filters by MIME type and size, downloads sequentially, catches per-file errors.
 */
export async function downloadFiles(
  files: SlackFile[],
  client: WebClient
): Promise<ConvertedFile[]> {
  const supported = filterSupportedFiles(files);
  if (supported.length === 0) return [];

  const results: ConvertedFile[] = [];
  for (const file of supported) {
    try {
      const converted = await downloadAsDataUri(file, client);
      results.push(converted);
    } catch (err) {
      console.error(`Error downloading file ${file.name}:`, err);
    }
  }
  return results;
}
