/**
 * The surfaces this bot runs on (Slack, plus any enabled at startup), keyed by
 * `Surface.kind`. Holds what config and agent resolution need to know about a
 * surface, so per-surface behavior isn't hard-coded at the call sites.
 */
export interface SurfaceInfo {
  id: string;
  /** Shown in config replies, e.g. "Linear". */
  name: string;
  /** The scheduler tools need Slack channel and user IDs, so other surfaces turn them off. */
  scheduling: boolean;
}

const surfaces = new Map<string, SurfaceInfo>([
  ["slack", { id: "slack", name: "Slack", scheduling: true }],
]);

/** Call at startup, before the OpenCode config is written. */
export function registerSurface(info: SurfaceInfo): void {
  surfaces.set(info.id, info);
}

export function getSurface(id: string): SurfaceInfo | undefined {
  return surfaces.get(id);
}

export function listSurfaces(): SurfaceInfo[] {
  return [...surfaces.values()];
}

export function surfaceCanSchedule(id: string): boolean {
  return surfaces.get(id)?.scheduling ?? true;
}
