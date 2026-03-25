/**
 * Vector store for semantic search over knowledge files and memories.
 *
 * Uses LanceDB (embedded, on-disk) for vector storage and
 * @huggingface/transformers with all-MiniLM-L6-v2 for local embeddings.
 */
import * as lancedb from "@lancedb/lancedb";
import { pipeline, env as txEnv, type FeatureExtractionPipeline } from "@huggingface/transformers";
import Database from "better-sqlite3";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

// Point the model cache at a writable location (Docker has read-only node_modules)
if (process.env.HF_CACHE_DIR) {
  txEnv.cacheDir = process.env.HF_CACHE_DIR;
}

const LANCE_DIR = process.env.LANCE_DIR ?? path.join(
  process.env.KNOWLEDGE_DIR ?? "/app/knowledge",
  ".lancedb",
);
const KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR ?? "/app/knowledge";
const DB_PATH = process.env.SESSIONS_DB_PATH ?? path.join(process.cwd(), "sessions.db");

const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const EMBEDDING_DIMS = 384;

// ── Embedding pipeline (lazy singleton) ──

let embedderPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getEmbedder(): Promise<FeatureExtractionPipeline> {
  if (!embedderPromise) {
    embedderPromise = pipeline("feature-extraction", EMBEDDING_MODEL).then(
      (p) => p as FeatureExtractionPipeline,
    );
  }
  return embedderPromise;
}

export async function embed(text: string): Promise<number[]> {
  const model = await getEmbedder();
  const result = await model(text, { pooling: "mean", normalize: true });
  return Array.from(result.data as Float32Array);
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  // Process sequentially to avoid OOM on large batches
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}

// ── LanceDB connection (lazy singleton) ──

let db: lancedb.Connection | null = null;

async function getDb(): Promise<lancedb.Connection> {
  if (!db) {
    db = await lancedb.connect(LANCE_DIR);
  }
  return db;
}

// ── Knowledge indexing ──

type KnowledgeRecord = Record<string, unknown> & {
  id: string;
  scope: string;
  file: string;
  chunk: string;
  vector: number[];
};

/**
 * Chunk a markdown file into smaller pieces for embedding.
 * Splits on double newlines (paragraphs), merging small chunks.
 */
function chunkText(text: string, maxChunkLen = 500): string[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current.length + trimmed.length + 2 > maxChunkLen && current) {
      chunks.push(current.trim());
      current = trimmed;
    } else {
      current += (current ? "\n\n" : "") + trimmed;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // If the whole text is shorter than maxChunkLen, return it as one chunk
  if (chunks.length === 0 && text.trim()) chunks.push(text.trim());

  return chunks;
}

/** Scan knowledge dir and return all file entries with content. */
function scanKnowledgeFiles(): Array<{ scope: string; file: string; content: string; mtime: number }> {
  const entries: Array<{ scope: string; file: string; content: string; mtime: number }> = [];

  const scanDir = (dir: string, scope: string) => {
    if (!existsSync(dir)) return;
    try {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
        const fullPath = path.join(dir, file);
        const stat = statSync(fullPath);
        const content = readFileSync(fullPath, "utf-8").trim();
        if (content) entries.push({ scope, file, content, mtime: stat.mtimeMs });
      }
    } catch { /* ignore */ }
  };

  scanDir(path.join(KNOWLEDGE_DIR, "global"), "global");

  const reposDir = path.join(KNOWLEDGE_DIR, "repos");
  if (existsSync(reposDir)) {
    for (const entry of readdirSync(reposDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scanDir(path.join(reposDir, entry.name), `repo:${entry.name}`);
      }
    }
  }

  const channelsDir = path.join(KNOWLEDGE_DIR, "channels");
  if (existsSync(channelsDir)) {
    for (const entry of readdirSync(channelsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scanDir(path.join(channelsDir, entry.name), `channel:${entry.name}`);
      }
    }
  }

  return entries;
}

let lastKnowledgeIndexTime = 0;

export async function indexKnowledgeFiles(): Promise<void> {
  const files = scanKnowledgeFiles();
  if (files.length === 0) return;

  // Check if any file is newer than the last index
  const maxMtime = Math.max(...files.map((f) => f.mtime));
  if (maxMtime <= lastKnowledgeIndexTime) return;

  console.log(`[vector] Indexing ${files.length} knowledge files...`);

  const records: KnowledgeRecord[] = [];
  for (const file of files) {
    const chunks = chunkText(file.content);
    const vectors = await embedBatch(chunks);

    for (let i = 0; i < chunks.length; i++) {
      records.push({
        id: `${file.scope}/${file.file}#${i}`,
        scope: file.scope,
        file: file.file,
        chunk: chunks[i],
        vector: vectors[i],
      });
    }
  }

  if (records.length === 0) return;

  const conn = await getDb();
  const tableNames = await conn.tableNames();

  if (tableNames.includes("knowledge")) {
    await conn.dropTable("knowledge");
  }
  await conn.createTable("knowledge", records);

  lastKnowledgeIndexTime = maxMtime;
  console.log(`[vector] Indexed ${records.length} knowledge chunks.`);
}

export async function searchKnowledge(
  query: string,
  scope?: string,
  limit = 10,
): Promise<Array<{ scope: string; file: string; chunk: string; score: number }>> {
  await indexKnowledgeFiles();

  const conn = await getDb();
  const tableNames = await conn.tableNames();
  if (!tableNames.includes("knowledge")) return [];

  const table = await conn.openTable("knowledge");
  const queryVec = await embed(query);

  const vectorSearch = table.search(queryVec) as lancedb.VectorQuery;
  let search = vectorSearch.distanceType("cosine").limit(limit);
  if (scope) {
    const esc = (s: string) => s.replace(/'/g, "''");
    search = search.where(`scope = '${esc(scope)}'`);
  }

  const results = await search.toArray();
  return results.map((r: Record<string, unknown>) => ({
    scope: r.scope as string,
    file: r.file as string,
    chunk: r.chunk as string,
    score: 1 - (r._distance as number), // cosine distance → cosine similarity
  }));
}

// ── Memory indexing ──

type MemoryRecord = Record<string, unknown> & {
  id: number;
  content: string;
  scope: string;
  scope_key: string;
  tags: string;
  created_by: string;
  created_at: number;
  vector: number[];
};

interface SqliteMemoryRow {
  id: number;
  content: string;
  scope: string;
  scope_key: string | null;
  tags: string | null;
  created_by: string;
  created_at: number;
}

let lastIndexedMemoryId = 0;
let memoryWatermarkInitialized = false;

/** Sync any new memories from SQLite into LanceDB. */
async function syncMemoryIndex(): Promise<void> {
  // On first call, initialize watermark from existing LanceDB data to avoid duplicates
  if (!memoryWatermarkInitialized) {
    memoryWatermarkInitialized = true;
    try {
      const conn = await getDb();
      const tableNames = await conn.tableNames();
      if (tableNames.includes("memories")) {
        const table = await conn.openTable("memories");
        // Query all rows, get max id
        const rows = await table.query().select(["id"]).toArray();
        if (rows.length > 0) {
          const maxId = Math.max(...rows.map((r: Record<string, unknown>) => r.id as number));
          lastIndexedMemoryId = maxId;
          console.log(`[vector] Initialized memory watermark at #${lastIndexedMemoryId}`);
        }
      }
    } catch (err) {
      console.warn("[vector] Failed to initialize memory watermark:", err);
    }
  }

  let sqliteDb: Database.Database;
  try {
    sqliteDb = new Database(DB_PATH, { readonly: true });
  } catch {
    return;
  }

  try {
    const newMemories = sqliteDb
      .prepare("SELECT * FROM memories WHERE id > ? ORDER BY id")
      .all(lastIndexedMemoryId) as SqliteMemoryRow[];

    if (newMemories.length === 0) return;

    console.log(`[vector] Indexing ${newMemories.length} new memories...`);

    const texts = newMemories.map((m) => {
      const parts = [m.content];
      if (m.tags) parts.push(m.tags);
      return parts.join(" ");
    });
    const vectors = await embedBatch(texts);

    const records: MemoryRecord[] = newMemories.map((m, i) => ({
      id: m.id,
      content: m.content,
      scope: m.scope,
      scope_key: m.scope_key ?? "",
      tags: m.tags ?? "",
      created_by: m.created_by,
      created_at: m.created_at,
      vector: vectors[i],
    }));

    const conn = await getDb();
    const tableNames = await conn.tableNames();

    if (tableNames.includes("memories")) {
      const table = await conn.openTable("memories");
      await table.add(records);
    } else {
      await conn.createTable("memories", records);
    }

    lastIndexedMemoryId = newMemories[newMemories.length - 1].id;
    console.log(`[vector] Indexed memories up to #${lastIndexedMemoryId}.`);
  } finally {
    sqliteDb.close();
  }
}

export async function searchMemories(
  query: string,
  scope?: string,
  scopeKey?: string,
  limit = 15,
): Promise<Array<{ id: number; content: string; scope: string; scope_key: string; tags: string; created_at: number; score: number }>> {
  await syncMemoryIndex();

  const conn = await getDb();
  const tableNames = await conn.tableNames();
  if (!tableNames.includes("memories")) return [];

  const table = await conn.openTable("memories");
  const queryVec = await embed(query);

  const esc = (s: string) => s.replace(/'/g, "''");
  const filters: string[] = [];
  if (scope) filters.push(`scope = '${esc(scope)}'`);
  if (scopeKey) filters.push(`scope_key = '${esc(scopeKey)}'`);

  const vectorSearch = table.search(queryVec) as lancedb.VectorQuery;
  let search = vectorSearch.distanceType("cosine").limit(limit);
  if (filters.length > 0) {
    search = search.where(filters.join(" AND "));
  }

  const results = await search.toArray();
  return results.map((r: Record<string, unknown>) => ({
    id: r.id as number,
    content: r.content as string,
    scope: r.scope as string,
    scope_key: r.scope_key as string,
    tags: r.tags as string,
    created_at: r.created_at as number,
    score: 1 - (r._distance as number), // cosine distance → cosine similarity
  }));
}

/**
 * Index a single memory immediately after save (called from save_memory tool).
 */
export async function indexSingleMemory(
  id: number,
  content: string,
  scope: string,
  scopeKey: string | null,
  tags: string | null,
  createdBy: string,
): Promise<void> {
  const vector = await embed(content + (tags ? " " + tags : ""));

  const record: MemoryRecord = {
    id,
    content,
    scope,
    scope_key: scopeKey ?? "",
    tags: tags ?? "",
    created_by: createdBy,
    created_at: Math.floor(Date.now() / 1000),
    vector,
  };

  const conn = await getDb();
  const tableNames = await conn.tableNames();

  if (tableNames.includes("memories")) {
    const table = await conn.openTable("memories");
    await table.add([record]);
  } else {
    await conn.createTable("memories", [record]);
  }

  // Update watermark so syncMemoryIndex doesn't re-index this
  if (id > lastIndexedMemoryId) lastIndexedMemoryId = id;
}

export async function getRecentMemories(
  scope?: string,
  scopeKey?: string,
  limit = 20,
): Promise<Array<{ id: number; content: string; scope: string; scope_key: string; tags: string; created_at: number }>> {
  // For listing recent memories, just query SQLite directly (no vector search needed)
  let sqliteDb: Database.Database;
  try {
    sqliteDb = new Database(DB_PATH, { readonly: true });
  } catch {
    return [];
  }

  try {
    if (scope && scopeKey) {
      return sqliteDb
        .prepare("SELECT id, content, scope, scope_key, tags, created_at FROM memories WHERE scope = ? AND scope_key = ? ORDER BY updated_at DESC LIMIT ?")
        .all(scope, scopeKey, limit) as Array<{ id: number; content: string; scope: string; scope_key: string; tags: string; created_at: number }>;
    }
    if (scope) {
      return sqliteDb
        .prepare("SELECT id, content, scope, scope_key, tags, created_at FROM memories WHERE scope = ? ORDER BY updated_at DESC LIMIT ?")
        .all(scope, limit) as Array<{ id: number; content: string; scope: string; scope_key: string; tags: string; created_at: number }>;
    }
    return sqliteDb
      .prepare("SELECT id, content, scope, scope_key, tags, created_at FROM memories ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Array<{ id: number; content: string; scope: string; scope_key: string; tags: string; created_at: number }>;
  } finally {
    sqliteDb.close();
  }
}
