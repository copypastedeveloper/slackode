/** Wires the Linear agent into the running bot: API client, agent, and webhook listener. */
import { registerSurface } from "../registry.js";
import { runTurn, stopThread } from "../run-turn.js";
import { LinearClient, type LinearIdentity } from "./client.js";
import { LinearAgent } from "./agent.js";
import { createLinearServer, listen, WEBHOOK_PATH } from "./server.js";
import type { LinearConfig } from "./config.js";

export interface LinearSurfaceHandle {
  /** Call once OpenCode is serving; webhook events received earlier wait for it. */
  markReady(): void;
  close(): Promise<void>;
}

/**
 * Start listening for Linear agent webhooks. Called before the slow parts of
 * startup so load balancer health checks pass while OpenCode boots.
 */
export async function startLinearSurface(config: LinearConfig): Promise<LinearSurfaceHandle> {
  // Before the OpenCode config is written, so the scheduler-free agents get generated.
  registerSurface({ id: "linear", name: "Linear", scheduling: false });
  const client = new LinearClient(config.clientId, config.clientSecret);

  let identity: Promise<LinearIdentity> | null = null;
  const getIdentity = (): Promise<LinearIdentity> => {
    identity ??= client.identity().catch((err) => {
      identity = null; // retry on the next call
      throw err;
    });
    return identity;
  };
  getIdentity().then(
    (id) => console.log(`[linear] Signed in as app user ${id.appUserId} in "${id.organizationName}"`),
    (err) => console.error("[linear] Could not fetch the app's Linear identity:", err instanceof Error ? err.message : err),
  );

  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });

  const agent = new LinearAgent({
    linear: client,
    getIdentity,
    ready,
    runTurn,
    stopThread,
  });

  const server = createLinearServer({
    webhookSecret: config.webhookSecret,
    onEvent: (payload) => { void agent.handle(payload); },
  });
  await listen(server, config.port);
  console.log(`[linear] Listening for Linear webhooks on :${config.port}${WEBHOOK_PATH}`);

  return {
    markReady,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
