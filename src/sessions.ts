// Thin re-export shim. The DB module was split into per-domain files under src/db/.
// All previously exported identifiers are re-exported from here so existing
// importers (`from "../sessions.js"` / `from "./sessions.js"`) keep working.

export { getDb, closeDb, type AuthType } from "./db/index.js";
export * from "./db/sessions.js";
export * from "./db/channels.js";
export * from "./db/tools.js";
export * from "./db/oauth.js";
export * from "./db/repos.js";
export * from "./db/coding.js";
export * from "./db/permissions.js";
export * from "./db/memory.js";
export * from "./db/github.js";
export * from "./db/knowledge.js";
export * from "./db/turns.js";
