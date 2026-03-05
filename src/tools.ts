import { getAllTools } from "./sessions.js";

/** Tools that can be enabled per-channel via `config set tools`. */
export function getKnownTools(): Record<string, string> {
  return Object.fromEntries(
    getAllTools().map((t) => [t.name, t.description])
  );
}

/** Per-tool instructions for the system prompt. */
export function getToolInstructions(): Record<string, string> {
  return Object.fromEntries(
    getAllTools().map((t) => [t.name, t.instruction])
  );
}

/** Max length for custom prompt instructions (shared across handlers). */
export const MAX_CUSTOM_PROMPT_LENGTH = 1000;
