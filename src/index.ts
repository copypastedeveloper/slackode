import bolt from "@slack/bolt";
const { App } = bolt;
import { initOpencode, abortSessionServerSide } from "./opencode.js";
import { getRun } from "./run-registry.js";
import { closeDb, seedToolsFromFile, bootstrapAdmins, hasRole } from "./sessions.js";
import { writeOpencodeConfig } from "./opencode-config.js";
import { setRepoDir, startServer, stopServer, restartServer } from "./opencode-server.js";
import { initRepos, generateContextForAllRepos } from "./repo-manager.js";
import {
  startSessionReaper, destroyAllCodingSessions, cleanupOrphanedSessions,
} from "./coding-session.js";
import { startPeriodicTokenRefresh, stopPeriodicTokenRefresh } from "./mcp/oauth-refresh.js";
import { startPeriodicGDocsSync, stopPeriodicGDocsSync } from "./gdocs-sync.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { approveProbationRun, approveProbationRunNoPost, rejectProbationRun, pauseJobFromRun } from "./job-runner.js";
import { handleMention } from "./handlers/mention.js";
import { handleDm } from "./handlers/dm.js";
import { handleStatus, handlePR, handleCancel } from "./handlers/code-commands.js";
import { resumeCodingWithAgent, resumeCodingWithRepo, handleApprove, handleRevise, resumeCodingAfterPATConnect } from "./handlers/coding-handler.js";
import { validateAndStoreGithubPAT } from "./handlers/github-commands.js";
import { Action, MAX_AGENT_BUTTONS, MAX_REPO_BUTTONS, GITHUB_CONNECT_MODAL_CALLBACK, OAUTH_COMPLETE_MODAL_CALLBACK, TURN_EXTENSION_MS } from "./constants.js";
import { completeOAuthExchange } from "./handlers/tool-commands.js";
import {
  openConfigureModal, retryConfigureModal, saveConfigureSubmission, TOOL_CONFIGURE_MODAL_CALLBACK,
} from "./handlers/tool-configure.js";

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

// Helper: check developer permission for button actions
async function requireDeveloper(
  userId: string, channel: string, threadTs: string, client: InstanceType<typeof App>["client"],
): Promise<boolean> {
  if (hasRole(userId, "developer")) return true;
  await client.chat.postEphemeral({
    channel, user: userId, thread_ts: threadTs,
    text: "This action requires *developer* permissions. Ask an admin to run `role add @you developer`.",
  });
  return false;
}

// Register coding session button actions
app.action(Action.CODING_STATUS, async ({ action, ack, body, client }) => {
  await ack();
  const threadTs = (action as { value: string }).value;
  const channel = (body as { channel?: { id: string } }).channel?.id;
  if (!channel) return;
  if (!(await requireDeveloper(body.user.id, channel, threadTs, client))) return;
  const reply = await handleStatus(threadTs);
  await client.chat.postMessage({ channel, thread_ts: threadTs, text: reply });
});

app.action(Action.CODING_PR, async ({ action, ack, body, client }) => {
  await ack();
  const threadTs = (action as { value: string }).value;
  const channel = (body as { channel?: { id: string } }).channel?.id;
  if (!channel) return;
  if (!(await requireDeveloper(body.user.id, channel, threadTs, client))) return;
  const reply = await handlePR(threadTs, body.user.id, undefined, false);
  await client.chat.postMessage({ channel, thread_ts: threadTs, text: reply });
});

app.action(Action.CODING_DONE, async ({ action, ack, body, client }) => {
  await ack();
  const threadTs = (action as { value: string }).value;
  const channel = (body as { channel?: { id: string } }).channel?.id;
  if (!channel) return;
  if (!(await requireDeveloper(body.user.id, channel, threadTs, client))) return;
  const reply = await handlePR(threadTs, body.user.id, undefined, true);
  await client.chat.postMessage({ channel, thread_ts: threadTs, text: reply });
});

// Scheduled-job probation buttons. These live in the job owner's DM, so the
// clicker is the owner by construction; we replace the button message with the
// outcome so a decision can't be applied twice.
function registerProbationAction(actionId: string, handle: (runId: string) => Promise<string> | string): void {
  app.action(actionId, async ({ action, ack, body, client }) => {
    await ack();
    const runId = (action as { value: string }).value;
    const channel = (body as { channel?: { id: string } }).channel?.id;
    const messageTs = (body as { message?: { ts: string } }).message?.ts;
    const outcome = await handle(runId);
    if (channel && messageTs) {
      await client.chat.update({ channel, ts: messageTs, text: outcome, blocks: [] });
    } else if (channel) {
      await client.chat.postMessage({ channel, text: outcome });
    }
  });
}
// Long-running Q&A turn controls ("still working — keep going?").
// Value = run key (channel:placeholderTs) into the in-memory run registry.
app.action(Action.RUN_STOP, async ({ action, ack, body, client }) => {
  await ack();
  const runKey = (action as { value: string }).value;
  const channel = (body as { channel?: { id: string } }).channel?.id;
  const messageTs = (body as { message?: { ts: string } }).message?.ts;
  const run = getRun(runKey);
  if (!run) {
    if (channel && messageTs) {
      await client.chat.update({ channel, ts: messageTs, text: "_That run already finished._", blocks: [] }).catch(() => {});
    }
    return;
  }
  run.stopRequested = true;
  run.controller.abort();
  await abortSessionServerSide(run.sessionId);
  if (channel && messageTs) {
    await client.chat.update({ channel, ts: messageTs, text: "_Stopping..._", blocks: [] }).catch(() => {});
  }
});

app.action(Action.RUN_KEEP_WAITING, async ({ action, ack, body, client }) => {
  await ack();
  const runKey = (action as { value: string }).value;
  const channel = (body as { channel?: { id: string } }).channel?.id;
  const messageTs = (body as { message?: { ts: string } }).message?.ts;
  const run = getRun(runKey);
  if (!run) {
    if (channel && messageTs) {
      await client.chat.update({ channel, ts: messageTs, text: "_That run already finished._", blocks: [] }).catch(() => {});
    }
    return;
  }
  run.extensions++;
  run.budget.deadlineAt = Date.now() + TURN_EXTENSION_MS;
  if (channel && messageTs) {
    await client.chat.update({
      channel,
      ts: messageTs,
      text: `_:+1: Keeping at it — up to ${Math.round(TURN_EXTENSION_MS / 60_000)} more minutes._`,
      blocks: [],
    }).catch(() => {});
  }
});

registerProbationAction(Action.JOB_POST, (runId) => approveProbationRun(runId, app.client));
registerProbationAction(Action.JOB_APPROVE, (runId) => approveProbationRunNoPost(runId));
registerProbationAction(Action.JOB_NEEDS_WORK, rejectProbationRun);
registerProbationAction(Action.JOB_PAUSE, pauseJobFromRun);

// Repo selection buttons (select_repo_0 through select_repo_N)
for (let i = 0; i < MAX_REPO_BUTTONS; i++) {
  app.action(`${Action.SELECT_REPO_PREFIX}${i}`, async ({ action, ack, body, client }) => {
    await ack();
    const { threadTs, repoName } = JSON.parse((action as { value: string }).value);
    const channel = (body as { channel?: { id: string } }).channel?.id;
    if (!channel) return;
    if (!(await requireDeveloper(body.user.id, channel, threadTs, client))) return;
    await resumeCodingWithRepo(threadTs, repoName, client, channel);
  });
}

// Agent selection buttons (select_agent_0 through select_agent_N)
for (let i = 0; i < MAX_AGENT_BUTTONS; i++) {
  app.action(`${Action.SELECT_AGENT_PREFIX}${i}`, async ({ action, ack, body, client }) => {
    await ack();
    const { threadTs, agent } = JSON.parse((action as { value: string }).value);
    const channel = (body as { channel?: { id: string } }).channel?.id;
    if (!channel) return;
    if (!(await requireDeveloper(body.user.id, channel, threadTs, client))) return;
    await resumeCodingWithAgent(threadTs, agent, client, channel);
  });
}

app.action(Action.CODING_APPROVE, async ({ action, ack, body, client }) => {
  await ack();
  const threadTs = (action as { value: string }).value;
  const channel = (body as { channel?: { id: string } }).channel?.id;
  if (!channel) return;
  if (!(await requireDeveloper(body.user.id, channel, threadTs, client))) return;
  await handleApprove(threadTs, body.user.id, client, channel);
});

app.action(Action.CODING_REVISE, async ({ action, ack, body, client }) => {
  await ack();
  const threadTs = (action as { value: string }).value;
  const channel = (body as { channel?: { id: string } }).channel?.id;
  if (!channel) return;
  if (!(await requireDeveloper(body.user.id, channel, threadTs, client))) return;
  await handleRevise(threadTs, body.user.id, client, channel);
});

app.action(Action.CODING_CANCEL, async ({ action, ack, body, client }) => {
  await ack();
  const threadTs = (action as { value: string }).value;
  const channel = (body as { channel?: { id: string } }).channel?.id;
  if (!channel) return;
  if (!(await requireDeveloper(body.user.id, channel, threadTs, client))) return;
  const reply = await handleCancel(threadTs, body.user.id);
  await client.chat.postMessage({ channel, thread_ts: threadTs, text: reply });
});

// GitHub Connect button → open modal
app.action(Action.GITHUB_CONNECT, async ({ action, ack, body, client }) => {
  await ack();
  const { threadTs, channelId } = JSON.parse((action as { value: string }).value);
  const triggerId = (body as { trigger_id?: string }).trigger_id;
  if (!triggerId) return;

  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: GITHUB_CONNECT_MODAL_CALLBACK,
      private_metadata: JSON.stringify({ threadTs, channelId }),
      title: { type: "plain_text", text: "Connect GitHub" },
      submit: { type: "plain_text", text: "Connect" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Enter a GitHub Personal Access Token with `repo` scope.\n" +
              "Create one at <https://github.com/settings/tokens>.",
          },
        },
        {
          type: "input",
          block_id: "pat_block",
          label: { type: "plain_text", text: "Personal Access Token" },
          element: {
            type: "plain_text_input",
            action_id: "pat_input",
            placeholder: { type: "plain_text", text: "ghp_... or github_pat_..." },
          },
        },
      ],
    },
  });
});

// GitHub Connect modal submission
app.view(GITHUB_CONNECT_MODAL_CALLBACK, async ({ ack, view, body, client }) => {
  const pat = view.state.values.pat_block.pat_input.value?.trim();
  const userId = body.user.id;
  const { threadTs, channelId } = JSON.parse(view.private_metadata);

  if (!pat) {
    await ack({
      response_action: "errors",
      errors: { pat_block: "Please enter a token." },
    });
    return;
  }

  try {
    const info = await validateAndStoreGithubPAT(userId, pat);
    await ack();

    // Post confirmation in thread
    await client.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `GitHub connected! Commits and PRs will be attributed to *${info.name}* (${info.username}, ${info.email}).`,
    });

    // Resume the pending coding session
    await resumeCodingAfterPATConnect(threadTs, client, channelId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await ack({
      response_action: "errors",
      errors: { pat_block: msg },
    });
  }
});

// OAuth Complete button → open modal
app.action(Action.OAUTH_COMPLETE, async ({ action, ack, body, client }) => {
  await ack();
  const toolName = (action as { value: string }).value;
  const triggerId = (body as { trigger_id?: string }).trigger_id;
  if (!triggerId) return;

  const channel = (body as { channel?: { id: string } }).channel?.id;
  const threadTs = (body as { message?: { thread_ts?: string; ts?: string } }).message?.thread_ts
    ?? (body as { message?: { ts?: string } }).message?.ts;

  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: OAUTH_COMPLETE_MODAL_CALLBACK,
      private_metadata: JSON.stringify({ toolName, channelId: channel, threadTs }),
      title: { type: "plain_text", text: "Complete OAuth" },
      submit: { type: "plain_text", text: "Authorize" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `Complete OAuth authorization for *${toolName}*.\nPaste the code and state from the redirect page.`,
          },
        },
        {
          type: "input",
          block_id: "code_block",
          label: { type: "plain_text", text: "Authorization Code" },
          element: {
            type: "plain_text_input",
            action_id: "code_input",
            placeholder: { type: "plain_text", text: "Paste the authorization code" },
          },
        },
        {
          type: "input",
          block_id: "state_block",
          label: { type: "plain_text", text: "State" },
          element: {
            type: "plain_text_input",
            action_id: "state_input",
            placeholder: { type: "plain_text", text: "Paste the state value" },
          },
          optional: true,
        },
      ],
    },
  });
});

// OAuth Complete modal submission
app.view(OAUTH_COMPLETE_MODAL_CALLBACK, async ({ ack, view, body, client }) => {
  const code = view.state.values.code_block.code_input.value?.trim();
  const oauthState = view.state.values.state_block.state_input.value?.trim();
  const { toolName, channelId, threadTs } = JSON.parse(view.private_metadata);

  if (!code) {
    await ack({
      response_action: "errors",
      errors: { code_block: "Please enter the authorization code." },
    });
    return;
  }

  await ack();

  await completeOAuthExchange(toolName, code, oauthState || undefined, client, channelId, threadTs);
});

// "Configure tools" button → open the tool-allowlist modal
app.action(Action.TOOL_CONFIGURE, async ({ action, ack, body, client }) => {
  await ack();
  const toolName = (action as { value: string }).value;
  const triggerId = (body as { trigger_id?: string }).trigger_id;
  if (!triggerId) return;
  await openConfigureModal(client, triggerId, toolName);
});

// Retry button inside the configure modal
app.action(Action.TOOL_CONFIGURE_RETRY, async ({ action, ack, body, client }) => {
  await ack();
  const toolName = (action as { value: string }).value;
  const viewId = (body as { view?: { id: string } }).view?.id;
  if (viewId) await retryConfigureModal(client, viewId, toolName);
});

// Configure-tools modal submission → save allowlist + restart
app.view(TOOL_CONFIGURE_MODAL_CALLBACK, async ({ ack, view, body, client }) => {
  await ack();
  const result = saveConfigureSubmission(view);
  if (!result) return;
  const { toolName, selected, all } = result;
  const elapsed = await restartServer();
  const summary = all.length > 0 && selected.length === all.length
    ? `all ${all.length} tools`
    : `${selected.length} of ${all.length} tools${selected.length ? " (" + selected.join(", ") + ")" : ""}`;
  const userId = body.user.id;
  const dm = await client.conversations.open({ users: userId });
  if (dm.channel?.id) {
    await client.chat.postMessage({
      channel: dm.channel.id,
      text: `:gear: \`${toolName}\` now exposes ${summary}. OpenCode restarted. _(took ${elapsed.toFixed(1)}s)_`,
    });
  }
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
  // 1a. Seed tools from tools.json on first boot (getDb() is called lazily inside)
  seedToolsFromFile(TOOLS_SEED_PATH);

  // 1b. Bootstrap admin users from env
  const adminUsersEnv = process.env.ADMIN_USERS;
  if (adminUsersEnv) {
    const adminIds = adminUsersEnv.split(",").map(s => s.trim()).filter(Boolean);
    bootstrapAdmins(adminIds);
    console.log(`[permissions] Bootstrapped ${adminIds.length} admin(s) from ADMIN_USERS`);
  }

  // 2. Generate opencode.json from DB-backed tool config
  setRepoDir(REPO_DIR);
  await writeOpencodeConfig(REPO_DIR);

  // 3. Start OpenCode server and wait for health
  await startServer();

  // 3b. Start periodic OAuth token refresh
  startPeriodicTokenRefresh();

  // 3c. Start periodic Google Docs sync (if service account configured)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    startPeriodicGDocsSync();
  }

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

  // 9. Start the scheduled-jobs tick (needs app.client for posting)
  startScheduler(app.client);

  // Generate context files after a delay so startup Q&A isn't rate-limited
  const CONTEXT_GEN_STARTUP_DELAY_MS = 5 * 60 * 1000; // 5 minutes
  setTimeout(() => {
    runContextGeneration();
    // Regenerate context every hour after the first run
    setInterval(runContextGeneration, CONTEXT_GEN_INTERVAL_MS);
  }, CONTEXT_GEN_STARTUP_DELAY_MS);
}

// Graceful shutdown
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    console.log(`[shutdown] ${signal} ignored — already shutting down`);
    return;
  }
  shuttingDown = true;
  console.log(`[shutdown] start (signal=${signal})`);
  try { stopScheduler(); } catch (e) { console.warn("[shutdown] stopScheduler:", e); }
  try { stopPeriodicTokenRefresh(); } catch (e) { console.warn("[shutdown] stopPeriodicTokenRefresh:", e); }
  try { stopPeriodicGDocsSync(); } catch (e) { console.warn("[shutdown] stopPeriodicGDocsSync:", e); }
  try { await destroyAllCodingSessions(); } catch (e) { console.warn("[shutdown] destroyAllCodingSessions:", e); }
  console.log("[shutdown] stopping opencode server");
  try { await stopServer(); } catch (e) { console.warn("[shutdown] stopServer:", e); }
  try { closeDb(); } catch (e) { console.warn("[shutdown] closeDb:", e); }
  console.log("[shutdown] done — exiting");
  process.exit(0);
}

process.on("SIGINT", () => { shutdown("SIGINT"); });
process.on("SIGTERM", () => { shutdown("SIGTERM"); });

start().catch((error) => {
  console.error("Failed to start:", error);
  closeDb();
  process.exit(1);
});
