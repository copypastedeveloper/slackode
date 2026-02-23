import bolt from "@slack/bolt";
const { App } = bolt;
import { initOpencode, generateContext } from "./opencode.js";
import { handleMention } from "./handlers/mention.js";
import { handleDm } from "./handlers/dm.js";
import { closeDb } from "./sessions.js";

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const OPENCODE_URL = process.env.OPENCODE_URL ?? "http://127.0.0.1:4096";
const CONTEXT_GEN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

if (!SLACK_BOT_TOKEN) {
  throw new Error("SLACK_BOT_TOKEN environment variable is required");
}
if (!SLACK_APP_TOKEN) {
  throw new Error("SLACK_APP_TOKEN environment variable is required");
}

// Initialize OpenCode client
initOpencode(OPENCODE_URL);

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
  await app.start();
  console.log(`Slack bot is running (OpenCode server: ${OPENCODE_URL})`);

  // Generate context files on startup (non-blocking — bot is already serving)
  runContextGeneration();

  // Regenerate context every hour
  setInterval(runContextGeneration, CONTEXT_GEN_INTERVAL_MS);
}

// Graceful shutdown
function shutdown(): void {
  console.log("Shutting down...");
  closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

start().catch((error) => {
  console.error("Failed to start:", error);
  closeDb();
  process.exit(1);
});
