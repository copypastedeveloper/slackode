import bolt from "@slack/bolt";
const { App } = bolt;
import { initOpencode } from "./opencode.js";
import { closeDb, seedToolsFromFile } from "./sessions.js";
import { writeOpencodeConfig } from "./opencode-config.js";
import { setRepoDir, startServer, stopServer } from "./opencode-server.js";
import { initRepos, generateContextForAllRepos } from "./repo-manager.js";
import {
  startSessionReaper, destroyAllCodingSessions, cleanupOrphanedSessions,
} from "./coding-session.js";
import { handleMention } from "./handlers/mention.js";
import { handleDm } from "./handlers/dm.js";
import { handleStatus, handlePR, handleCancel } from "./handlers/code-commands.js";
import { resumeCodingWithAgent, handleApprove, handleRevise } from "./handlers/coding-handler.js";
import { Action, MAX_AGENT_BUTTONS } from "./constants.js";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const OPENCODE_URL = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
const REPO_DIR = process.env.REPO_DIR ?? "/app/repo";
const TOOLS_SEED_PATH = process.env.TOOLS_SEED_PATH ?? "/app/tools.json";
const CONTEXT_GEN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

if (!SLACK_BOT_TOKEN) {
  throw new Error("SLACK_BOT_TOKEN environment variable is required");
}
if (!SLACK_APP_TOKEN) {
  throw new Error("SLACK_APP_TOKEN environment variable is required");
}

// Initialize Bolt app with Socket Mode
const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
});

// Register event handlers
app.event("app_mention", handleMention);
app.event("message", handleDm);

// Register coding session button actions
app.action(Action.CODING_STATUS, async ({ action, ack, body, client }) => {
  await ack();
  const threadTs = (action as { value: string }).value;
  const channel = (body as { channel?: { id: string } }).channel?.id;
  if (!channel) return;
  const reply = await handleStatus(threadTs);
  await client.chat.postMessage({ channel, thread_ts: threadTs, text: reply });
});

app.action(Action.CODING_PR, async ({ action, ack, body, client }) => {
  await ack();
  const threadTs = (action as { value: string }).value;
  const channel = (body as { channel?: { id: string } }).channel?.id;
  if (!channel) return;
  const reply = await handlePR(threadTs, body.user.id, undefined, false);
  await client.chat.postMessage({ channel, thread_ts: threadTs, text: reply });
});

app.action(Action.CODING_DONE, async ({ action, ack, body, client }) => {
  await ack();
  const threadTs = (action as { value: string }).value;
  const channel = (body as { channel?: { id: string } }).channel?.id;
  if (!channel) return;
  const reply = await handlePR(threadTs, body.user.id, undefined, true);
  await client.chat.postMessage({ channel, thread_ts: threadTs, text: reply });
});

// Agent selection buttons (select_agent_0 through select_agent_N)
for (let i = 0; i < MAX_AGENT_BUTTONS; i++) {
  app.action(`${Action.SELECT_AGENT_PREFIX}${i}`, async ({ action, ack, body, client }) => {
    await ack();
    const { threadTs, agent } = JSON.parse((action as { value: string }).value);
    const channel = (body as { channel?: { id: string } }).channel?.id;
    if (!channel) return;
    await resumeCodingWithAgent(threadTs, agent, client, channel);
  });
}

app.action(Action.CODING_APPROVE, async ({ action, ack, body, client }) => {
  await ack();
  const threadTs = (action as { value: string }).value;
  const channel = (body as { channel?: { id: string } }).channel?.id;
  if (!channel) return;
  await handleApprove(threadTs, body.user.id, client, channel);
});

app.action(Action.CODING_REVISE, async ({ action, ack, body, client }) => {
  await ack();
  const threadTs = (action as { value: string }).value;
  const channel = (body as { channel?: { id: string } }).channel?.id;
  if (!channel) return;
  await handleRevise(threadTs, body.user.id, client, channel);
});

app.action(Action.CODING_CANCEL, async ({ action, ack, body, client }) => {
  await ack();
  const threadTs = (action as { value: string }).value;
  const channel = (body as { channel?: { id: string } }).channel?.id;
  if (!channel) return;
  const reply = await handleCancel(threadTs, body.user.id);
  await client.chat.postMessage({ channel, thread_ts: threadTs, text: reply });
});

/**
 * Run context generation for all repos, logging errors but never crashing the bot.
 */
async function runContextGeneration(): Promise<void> {
  try {
    await generateContextForAllRepos();
  } catch (error) {
    console.error("[context-gen] Failed:", error);
  }
}

// Start the app
async function start(): Promise<void> {
  // 1. Seed tools from tools.json on first boot (getDb() is called lazily inside)
  seedToolsFromFile(TOOLS_SEED_PATH);

  // 2. Generate opencode.json from DB-backed tool config
  setRepoDir(REPO_DIR);
  writeOpencodeConfig(REPO_DIR);

  // 3. Start OpenCode server and wait for health
  await startServer();

  // 4. Initialize OpenCode SDK client
  initOpencode(OPENCODE_URL);

  // 5. Initialize repo manager (seeds default repo from env if needed)
  await initRepos();

  // 6. Clean up any orphaned coding sessions from a prior crash
  cleanupOrphanedSessions();

  // 7. Start Slack bot
  await app.start();
  console.log(`Slack bot is running (OpenCode server: ${OPENCODE_URL})`);

  // 8. Start coding session idle reaper (every 5 min)
  const reaperInterval = startSessionReaper();

  // Generate context files on startup (non-blocking — bot is already serving)
  runContextGeneration();

  // Regenerate context every hour
  setInterval(runContextGeneration, CONTEXT_GEN_INTERVAL_MS);
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("Shutting down...");
  await destroyAllCodingSessions();
  await stopServer();
  closeDb();
  process.exit(0);
}

process.on("SIGINT", () => { shutdown(); });
process.on("SIGTERM", () => { shutdown(); });

start().catch((error) => {
  console.error("Failed to start:", error);
  closeDb();
  process.exit(1);
});
