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
  /** Stop's server-side abort; the runner waits for it before the turn ends. */
  serverAbort?: Promise<void>;
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

/** Stop a run client and server side. A second call is a no-op. */
export function requestStop(run: ActiveRun, abortServerSide: (sessionId: string) => Promise<void>): void {
  if (run.stopRequested) return;
  run.stopRequested = true;
  run.controller.abort();
  run.serverAbort = abortServerSide(run.sessionId).catch(() => {});
}

/** Stop the run under `key`. Returns it, or undefined if it already finished. */
export function stopRun(key: string, abortServerSide: (sessionId: string) => Promise<void>): ActiveRun | undefined {
  const run = runs.get(key);
  if (run) requestStop(run, abortServerSide);
  return run;
}
