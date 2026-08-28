// ── In-memory registry of in-flight Q&A runs ──
//
// Lets the "still working — keep going?" Slack buttons reach into a running
// handleQuestion: Stop aborts the run (client + server side), Keep waiting
// extends its deadline. Entries live only for the duration of the turn and
// only in this process — a restart drops them, which is fine because the runs
// they point at die with the process too.

export interface TurnBudget {
  /** Epoch ms after which the stream watchdog terminates the turn. Mutable — extended by "keep waiting". */
  deadlineAt: number;
}

export interface ActiveRun {
  sessionId: string;
  controller: AbortController;
  budget: TurnBudget;
  /** Set by the Stop button so the runner can distinguish a user stop from other aborts. */
  stopRequested: boolean;
  /** How many times "keep waiting" was clicked (capped to avoid unbounded runs). */
  extensions: number;
}

const runs = new Map<string, ActiveRun>();

export function registerRun(key: string, run: ActiveRun): void {
  runs.set(key, run);
}

export function getRun(key: string): ActiveRun | undefined {
  return runs.get(key);
}

export function removeRun(key: string): void {
  runs.delete(key);
}
