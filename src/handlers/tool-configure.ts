import type { WebClient } from "@slack/web-api";
import type { KnownBlock, View } from "@slack/types";
import { getToolFromDb, parseAllowedTools, setToolAllowedTools } from "../sessions.js";
import { listMcpTools } from "../mcp/list-tools.js";
import { Action } from "../constants.js";

export const TOOL_CONFIGURE_MODAL_CALLBACK = "tool_configure_modal";

const CHECKBOX_MAX = 10; // Slack allows at most 10 options per checkboxes element.

/** A "Configure tools" button (opens the modal). Post-able after add/auth or in `tool list`. */
export function configureButtonBlock(toolName: string): KnownBlock {
  return {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Configure tools" },
        action_id: Action.TOOL_CONFIGURE,
        value: toolName,
      },
    ],
  };
}

/** Loading placeholder shown immediately (before the trigger_id expires). */
function loadingView(toolName: string): View {
  return {
    type: "modal",
    callback_id: TOOL_CONFIGURE_MODAL_CALLBACK,
    private_metadata: JSON.stringify({ toolName }),
    title: { type: "plain_text", text: "Configure tools" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `Loading tools for \`${toolName}\`…` } },
    ],
  };
}

function errorView(toolName: string, message: string): View {
  return {
    type: "modal",
    callback_id: TOOL_CONFIGURE_MODAL_CALLBACK,
    private_metadata: JSON.stringify({ toolName }),
    title: { type: "plain_text", text: "Configure tools" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `:warning: Couldn't load tools for \`${toolName}\`:\n> ${message}` } },
      {
        type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Retry" }, action_id: Action.TOOL_CONFIGURE_RETRY, value: toolName },
        ],
      },
    ],
  };
}

function checklistView(toolName: string, toolNames: string[], allowed: string[]): View {
  // Empty allowlist means "all allowed" → start with everything checked.
  const checkedSet = allowed.length === 0 ? new Set(toolNames) : new Set(allowed);

  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Select which tools \`${toolName}\` exposes to the agent. Unchecked tools are hidden everywhere the server is enabled.`,
      },
    },
    { type: "divider" },
  ];

  for (let i = 0; i < toolNames.length; i += CHECKBOX_MAX) {
    const chunk = toolNames.slice(i, i + CHECKBOX_MAX);
    const options = chunk.map((t) => ({ text: { type: "plain_text" as const, text: t }, value: t }));
    const initial = options.filter((o) => checkedSet.has(o.value));
    blocks.push({
      type: "input",
      block_id: `tools_${i}`,
      optional: true,
      label: { type: "plain_text", text: toolNames.length > CHECKBOX_MAX ? `Tools ${i + 1}–${i + chunk.length}` : "Tools" },
      element: {
        type: "checkboxes",
        action_id: "sel",
        options,
        // Slack rejects an empty initial_options array — omit when nothing checked.
        ...(initial.length > 0 ? { initial_options: initial } : {}),
      },
    });
  }

  return {
    type: "modal",
    callback_id: TOOL_CONFIGURE_MODAL_CALLBACK,
    private_metadata: JSON.stringify({ toolName, all: toolNames }),
    title: { type: "plain_text", text: "Configure tools" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

/** Fetch the server's tools and render the checklist into an existing modal (open or retry). */
async function renderInto(client: WebClient, viewId: string, toolName: string): Promise<void> {
  const tool = getToolFromDb(toolName);
  if (!tool) {
    await client.views.update({ view_id: viewId, view: errorView(toolName, "Tool not found.") });
    return;
  }
  try {
    const toolNames = await listMcpTools(tool);
    if (toolNames.length === 0) {
      await client.views.update({ view_id: viewId, view: errorView(toolName, "The server reported no tools.") });
      return;
    }
    const allowed = parseAllowedTools(tool.allowed_tools);
    await client.views.update({ view_id: viewId, view: checklistView(toolName, toolNames, allowed) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await client.views.update({ view_id: viewId, view: errorView(toolName, msg) });
  }
}

/** Open the modal (loading), then load tools asynchronously. Called from the button action. */
export async function openConfigureModal(client: WebClient, triggerId: string, toolName: string): Promise<void> {
  const opened = await client.views.open({ trigger_id: triggerId, view: loadingView(toolName) });
  const viewId = opened.view?.id;
  if (viewId) await renderInto(client, viewId, toolName);
}

/** Retry loading tools inside an already-open modal. Called from the Retry button action. */
export async function retryConfigureModal(client: WebClient, viewId: string, toolName: string): Promise<void> {
  await client.views.update({ view_id: viewId, view: loadingView(toolName) });
  await renderInto(client, viewId, toolName);
}

/**
 * Persist the modal submission. Returns the tool name (for a config restart),
 * or null if nothing changed / tool missing.
 */
export function saveConfigureSubmission(view: {
  private_metadata: string;
  state: { values: Record<string, Record<string, { selected_options?: Array<{ value: string }> }>> };
}): { toolName: string; selected: string[]; all: string[] } | null {
  const meta = JSON.parse(view.private_metadata) as { toolName: string; all?: string[] };
  const all = meta.all ?? [];
  const selected: string[] = [];
  for (const [blockId, actions] of Object.entries(view.state.values)) {
    if (!blockId.startsWith("tools_")) continue;
    for (const opts of Object.values(actions)) {
      for (const o of opts.selected_options ?? []) selected.push(o.value);
    }
  }
  // All selected ⇒ store null (all allowed) so future-added tools stay available.
  const allSelected = all.length > 0 && selected.length === all.length;
  setToolAllowedTools(meta.toolName, allSelected ? null : selected);
  return { toolName: meta.toolName, selected, all };
}
