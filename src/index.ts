import bolt from "@slack/bolt";
const { App } = bolt;
import { initOpencode } from "./opencode.js";
import { generateContext } from "./context-gen.js";
import { closeDb, seedToolsFromFile } from "./sessions.js";
import { writeOpencodeConfig } from "./opencode-config.js";
import { setRepoDir, startServer, stopServer } from "./opencode-server.js";
import { handleMention } from "./handlers/mention.js";
import { handleDm } from "./handlers/dm.js";

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

/**
 * Run context generation, logging errors but never crashing the bot.
 */
async function runContextGeneration(): Promise<void> {
  try {
    await generateContext();
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

  // 5. Start Slack bot
  await app.start();
  console.log(`Slack bot is running (OpenCode server: ${OPENCODE_URL})`);

  // Generate context files on startup (non-blocking — bot is already serving)
  runContextGeneration();

  // Regenerate context every hour
  setInterval(runContextGeneration, CONTEXT_GEN_INTERVAL_MS);
}

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("Shutting down...");
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
