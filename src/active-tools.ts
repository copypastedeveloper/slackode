/**
 * The set of tool names that made it into the generated opencode.json
 * (i.e. enabled AND authorized). Set by writeOpencodeConfig on every config
 * generation; read by agent-variant resolution so channel tool lists that
 * reference removed/unauthorized tools don't compose nonexistent agent names.
 */
let activeTools: Set<string> | null = null;

export function setActiveTools(names: string[]): void {
  activeTools = new Set(names);
}

/** Null until the first config generation has run. */
export function getActiveTools(): Set<string> | null {
  return activeTools;
}
