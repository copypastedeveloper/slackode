import path from "node:path";
import { readFileSync } from "node:fs";

/** Load tool definitions from tools.json so adding a new tool is just a config change. */
interface ToolDef { description: string; instruction: string; env: string; mcp: Record<string, unknown> }
const TOOLS_JSON_PATH = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "tools.json");
const toolDefs: Record<string, ToolDef> = JSON.parse(readFileSync(TOOLS_JSON_PATH, "utf-8"));

/** Tools that can be enabled per-channel via `config set tools`. */
export const KNOWN_TOOLS: Record<string, string> = Object.fromEntries(
  Object.entries(toolDefs).map(([name, def]) => [name, def.description])
);

/** Per-tool instructions for the system prompt. */
export const TOOL_INSTRUCTIONS: Record<string, string> = Object.fromEntries(
  Object.entries(toolDefs).map(([name, def]) => [name, def.instruction])
);

/** Max length for custom prompt instructions (shared across handlers). */
export const MAX_CUSTOM_PROMPT_LENGTH = 1000;
