/** Wires the Linear agent into the running bot: API client, agent, and webhook listener. */
import { askQuestion, abortSessionServerSide } from "../opencode.js";
import { buildPrefix } from "../context-prefix.js";
import { getOrCreateSession, deleteSessionMapping, isSessionCompacted, setSessionCompacted } from "../sessions.js";
import { waitForRestart } from "../opencode-server.js";
import { resolveRepoForChannel } from "../repo-manager.js";
import { getActiveTools } from "../active-tools.js";
import { TURN_HARD_CAP_MS } from "../constants.js";
import { LinearClient, type LinearIdentity } from "./client.js";
import { LinearAgent, type LinearAgentDeps } from "./agent.js";
import { createLinearServer, listen, WEBHOOK_PATH } from "./server.js";
import { LINEAR_AGENT_NAME, LINEAR_CHANNEL_ID, type LinearConfig } from "./config.js";

export interface LinearSurfaceHandle {
  /** Call once OpenCode is serving; webhook events received earlier wait for it. */
  markReady(): void;
  close(): Promise<void>;
}

/** Q&A prefix for a Linear turn: the Slack builder's rules and knowledge, with Linear formatting and context. */
const buildLinearPrefix: LinearAgentDeps["buildContextPrefix"] = (ctx, { isNew, tools, repo }) =>
  buildPrefix({
    ctx: {
      userId: ctx.userId ?? "",
      userName: ctx.userName,
      userDisplayName: ctx.userName,
      userTitle: "",
      userStatusText: "",
      channelId: LINEAR_CHANNEL_ID,
      channelName: `Linear ${ctx.issueIdentifier ?? ""}`.trim(),
      channelTopic: "",
      channelPurpose: "",
      channelType: "channel",
    },
    isNew,
    mode: "qa",
    tools,
    repo,
    surface: { kind: "linear", ...ctx },
  });

/**
 * Start listening for Linear agent webhooks. Called before the slow parts of
 * startup so load balancer health checks pass while OpenCode boots.
 */
export async function startLinearSurface(config: LinearConfig): Promise<LinearSurfaceHandle> {
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
    ask: askQuestion,
    abortServerSide: (sessionId) => abortSessionServerSide(sessionId),
    sessions: {
      getOrCreate: (threadKey) => getOrCreateSession(threadKey, LINEAR_CHANNEL_ID),
      remove: deleteSessionMapping,
      isCompacted: isSessionCompacted,
      setCompacted: setSessionCompacted,
    },
    waitForRestart,
    buildContextPrefix: buildLinearPrefix,
    resolveRepo: () => resolveRepoForChannel(LINEAR_CHANNEL_ID),
    // Only tools that made it into the generated OpenCode config.
    getTools: () => config.tools.filter((t) => getActiveTools()?.has(t) ?? true),
    agentName: LINEAR_AGENT_NAME,
    turnCapMs: TURN_HARD_CAP_MS,
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
