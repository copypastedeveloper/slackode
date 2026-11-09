/**
 * Wires the Linear surface into the running bot: the API client, the agent,
 * and the webhook listener.
 */
import type http from "node:http";
import { askQuestion, abortSessionServerSide } from "../opencode.js";
import { buildPrefix, type RepoInfo } from "../context-prefix.js";
import {
  getOrCreateSession, deleteSessionMapping, isSessionCompacted, setSessionCompacted,
} from "../sessions.js";
import { isRestarting, waitForRestart } from "../opencode-server.js";
import { resolveRepoForChannel } from "../repo-manager.js";
import { getActiveTools } from "../active-tools.js";
import { TURN_HARD_CAP_MS } from "../constants.js";
import type { SlackContext } from "../utils/slack-context.js";
import { LinearClient, type LinearIdentity } from "./client.js";
import { LinearAgent, type LinearTurnContext } from "./agent.js";
import { createLinearServer, listen, WEBHOOK_PATH } from "./server.js";
import { LINEAR_AGENT_NAME, LINEAR_CHANNEL_ID, type LinearConfig } from "./config.js";

export interface LinearSurfaceHandle {
  /** Call once OpenCode is serving; webhook events received earlier wait for it. */
  markReady(): void;
  close(): Promise<void>;
}

/** The configured Linear tools that actually made it into the generated OpenCode config. */
export function activeLinearTools(configured: string[]): string[] {
  const active = getActiveTools();
  return active ? configured.filter((t) => active.has(t)) : configured;
}

/** Build the Q&A context prefix for a Linear turn, reusing the Slack builder's rules and knowledge. */
export function buildLinearPrefix(
  ctx: LinearTurnContext,
  opts: { isNew: boolean; tools: string[]; repo?: RepoInfo },
): string {
  const slackShaped: SlackContext = {
    userId: ctx.userId ?? "",
    userName: ctx.userName,
    userDisplayName: ctx.userName,
    userTitle: "",
    userStatusText: "",
    channelId: LINEAR_CHANNEL_ID,
    channelName: ctx.issueIdentifier ? `Linear ${ctx.issueIdentifier}` : "Linear",
    channelTopic: "",
    channelPurpose: "",
    channelType: "channel",
  };
  return buildPrefix({
    ctx: slackShaped,
    isNew: opts.isNew,
    mode: "qa",
    tools: opts.tools,
    repo: opts.repo,
    surface: {
      kind: "linear",
      issueIdentifier: ctx.issueIdentifier,
      issueTitle: ctx.issueTitle,
      issueUrl: ctx.issueUrl,
      userEmail: ctx.userEmail,
      guidance: ctx.guidance,
    },
  });
}

/**
 * Start listening for Linear agent webhooks. Call before the slow parts of
 * startup so load balancer health checks pass while OpenCode boots.
 */
export async function startLinearSurface(config: LinearConfig): Promise<LinearSurfaceHandle> {
  const client = new LinearClient(config.clientId, config.clientSecret);

  let identity: Promise<LinearIdentity> | null = null;
  const getIdentity = (): Promise<LinearIdentity> => {
    identity ??= client.identity().catch((err) => {
      identity = null; // retry on the next event
      throw err;
    });
    return identity;
  };
  getIdentity().then(
    (id) => console.log(`[linear] Signed in as app user ${id.appUserId} in "${id.organizationName}"`),
    (err) => console.error("[linear] Could not fetch the app's Linear identity (will retry on the next event):", err instanceof Error ? err.message : err),
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
      getOrCreate: (threadKey) => getOrCreateSession(threadKey, LINEAR_CHANNEL_ID, `Linear session: ${threadKey}`),
      remove: deleteSessionMapping,
      isCompacted: isSessionCompacted,
      setCompacted: setSessionCompacted,
    },
    server: { isRestarting, waitForRestart },
    buildContextPrefix: buildLinearPrefix,
    resolveRepo: () => resolveRepoForChannel(LINEAR_CHANNEL_ID),
    getTools: () => activeLinearTools(config.tools),
    agentName: LINEAR_AGENT_NAME,
    turnCapMs: TURN_HARD_CAP_MS,
  });

  const server: http.Server = createLinearServer({
    webhookSecret: config.webhookSecret,
    onEvent: (payload) => { void agent.handle(payload); },
  });
  await listen(server, config.port);
  console.log(`[linear] Listening for Linear webhooks on :${config.port}${WEBHOOK_PATH}`);

  return {
    markReady,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}
