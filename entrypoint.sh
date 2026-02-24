#!/bin/bash
set -e

# ── Provider configuration ──
PROVIDER="${PROVIDER:-github-copilot}"
MODEL="${MODEL:-claude-sonnet-4.6}"

# ── Neutralize the target repo's own agent/skill/plugin files ──
# Some repos ship their own .opencode/agents/, .opencode/plugin/,
# and .claude/skills/ directories. OpenCode auto-discovers and loads these,
# causing the agent to behave as a development assistant (editing files,
# spawning subagents, loading skills). We must remove them after every
# clone/pull so the agent stays read-only.
clean_repo_agents() {
  local repo="$1"
  echo "Cleaning repo agent/skill/plugin files..."
  rm -rf "$repo/.opencode/agents"
  rm -rf "$repo/.opencode/plugin"
  rm -rf "$repo/.opencode/plugins"
  rm -rf "$repo/.claude/skills"
  rm -rf "$repo/.claude"
  rm -rf "$repo/.agents"
  # Also remove any nested .opencode config that could override ours
  rm -f "$repo/.opencode/opencode.json"
  rm -f "$repo/.opencode/.opencode"
  echo "Repo agent/skill/plugin files cleaned."
}

# ── Pre-seed OpenCode auth ──
# Only github-copilot requires a pre-seeded auth.json (OAuth token).
# Other providers use standard API key env vars that OpenCode reads directly.
if [ "$PROVIDER" = "github-copilot" ]; then
  if [ -n "$COPILOT_TOKEN" ]; then
    AUTH_DIR="$HOME/.local/share/opencode"
    mkdir -p "$AUTH_DIR"
    # Use printf to safely embed the token without shell interpretation
    printf '{"github-copilot":{"type":"oauth","access":"%s","refresh":"%s","expires":0}}\n' \
      "$COPILOT_TOKEN" "$COPILOT_TOKEN" > "$AUTH_DIR/auth.json"
    echo "Copilot auth.json written to $AUTH_DIR/auth.json"
  else
    echo "ERROR: COPILOT_TOKEN is required when PROVIDER=github-copilot"
    echo "Run 'opencode auth login' locally, then copy the gho_ token from ~/.local/share/opencode/auth.json"
    exit 1
  fi
fi

# ── Validate provider-specific requirements ──
case "$PROVIDER" in
  github-copilot) ;;  # handled above
  anthropic)
    [ -z "$ANTHROPIC_API_KEY" ] && echo "ERROR: ANTHROPIC_API_KEY is required when PROVIDER=anthropic" && exit 1 ;;
  openai)
    [ -z "$OPENAI_API_KEY" ] && echo "ERROR: OPENAI_API_KEY is required when PROVIDER=openai" && exit 1 ;;
  amazon-bedrock)
    [ -z "$AWS_REGION" ] && echo "WARNING: AWS_REGION is not set — Bedrock may fail." ;;
  google-vertex-ai)
    [ -z "$GOOGLE_CLOUD_PROJECT" ] && echo "WARNING: GOOGLE_CLOUD_PROJECT is not set — Vertex AI may fail." ;;
  *)
    echo "Using provider: $PROVIDER — ensure its API key env var is set." ;;
esac
echo "Provider: $PROVIDER, Model: $MODEL"

# ── Clone or update the repo ──
if [ -z "$TARGET_REPO" ]; then
  echo "ERROR: TARGET_REPO is not set (e.g. TARGET_REPO=your-org/your-repo)"
  exit 1
fi

# Validate TARGET_REPO format (owner/repo, alphanumeric with hyphens/underscores/dots)
if ! echo "$TARGET_REPO" | grep -qE '^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$'; then
  echo "ERROR: TARGET_REPO must be in 'owner/repo' format (got: $TARGET_REPO)"
  exit 1
fi

REPO_URL="https://github.com/${TARGET_REPO}.git"

if [ -n "$GITHUB_TOKEN" ]; then
  # Use GIT_ASKPASS to supply credentials without embedding them in the URL
  # or persisting them in .git/config
  GIT_ASKPASS_SCRIPT="$(mktemp)"
  printf '#!/bin/sh\necho "%s"\n' "$GITHUB_TOKEN" > "$GIT_ASKPASS_SCRIPT"
  chmod +x "$GIT_ASKPASS_SCRIPT"
  export GIT_ASKPASS="$GIT_ASKPASS_SCRIPT"
  export GIT_TERMINAL_PROMPT=0
else
  echo "WARNING: GITHUB_TOKEN is not set — clone may fail for private repos."
fi

if [ ! -d /app/repo/.git ]; then
  echo "Cloning ${TARGET_REPO}..."
  git clone "$REPO_URL" /app/repo
else
  # Ensure the remote URL doesn't contain embedded credentials from a prior run
  git -C /app/repo remote set-url origin "$REPO_URL"
  echo "Updating ${TARGET_REPO}..."
  git -C /app/repo pull || echo "Pull failed, continuing with existing checkout."
fi

# ── Neutralize repo's own agents/skills/plugins ──
clean_repo_agents /app/repo

# ── Copy OpenCode config into the repo directory ──
# opencode serve uses the cwd for config, so opencode.json and .opencode/rules/
# need to be present where the server runs.
cp /app/opencode.json /app/repo/opencode.json
sed -i 's|"model": "[^"]*"|"model": "'"${PROVIDER}/${MODEL}"'"|' /app/repo/opencode.json
mkdir -p /app/repo/.opencode/rules
cp /app/.opencode/rules/*.md /app/repo/.opencode/rules/

# ── Inject MCP servers and agent variants from tools.json ──
# Reads tools.json, checks which env vars are set, injects MCP configs,
# generates all agent variant combinations (2^N-1 for N enabled tools),
# and adds global tool disables. Adding a new tool is just a tools.json entry.
node -e "
const fs = require('fs');
const tools = JSON.parse(fs.readFileSync('/app/tools.json', 'utf-8'));
const config = JSON.parse(fs.readFileSync('/app/repo/opencode.json', 'utf-8'));

// Determine which tools have their env var set
const enabled = [];
for (const [name, def] of Object.entries(tools)) {
  if (!process.env[def.env]) {
    console.log('MCP: ' + name + ' skipped (' + def.env + ' not set).');
    continue;
  }
  enabled.push(name);

  // Build MCP server entry
  config.mcp = config.mcp || {};
  const mcp = def.mcp;
  if (mcp.type === 'remote') {
    config.mcp[name] = {
      type: 'remote',
      url: mcp.url,
      headers: { Authorization: (mcp.headerAuth || 'Bearer') + ' ' + process.env[def.env] },
      ...(mcp.oauth !== undefined ? { oauth: mcp.oauth } : {}),
      enabled: true,
    };
  } else if (mcp.type === 'local') {
    const entry = { type: 'local', command: mcp.command, enabled: true };
    if (mcp.envPassthrough) {
      entry.environment = { [def.env]: process.env[def.env] };
    }
    config.mcp[name] = entry;
  }
  console.log('MCP: ' + name + ' configured (' + mcp.type + ').');

  // Disable this tool's MCP tools globally (agents opt in)
  config.tools[name + '*'] = false;
}

if (enabled.length === 0) {
  console.log('MCP: No tool tokens configured.');
} else {
  // Generate agent variants for every non-empty subset of enabled tools.
  // E.g. [linear, sentry] -> build-linear, build-sentry, build-linear-sentry
  const buildAgent = config.agent.build;
  const count = enabled.length;
  for (let mask = 1; mask < (1 << count); mask++) {
    const subset = enabled.filter((_, i) => mask & (1 << i)).sort();
    const agentName = 'build-' + subset.join('-');
    const toolOverrides = {};
    for (const t of subset) toolOverrides[t + '*'] = true;
    config.agent[agentName] = {
      description: buildAgent.description + ' with ' + subset.join(', ') + ' tools',
      tools: { ...buildAgent.tools, ...toolOverrides },
      permission: { ...buildAgent.permission },
    };
  }
  console.log('MCP: Generated agent variants for: ' + enabled.join(', '));
}

fs.writeFileSync('/app/repo/opencode.json', JSON.stringify(config, null, 2));
"

# ── Start OpenCode server ──
echo "Starting OpenCode server..."
cd /app/repo
opencode serve --port 4096 --hostname 127.0.0.1 &
OPENCODE_PID=$!

# Wait for server to be healthy (timeout after 60s)
echo "Waiting for OpenCode server to be ready..."
SECONDS=0
until curl -sf http://127.0.0.1:4096/global/health > /dev/null 2>&1; do
  if [ $SECONDS -ge 60 ]; then
    echo "ERROR: OpenCode server failed to start within 60 seconds."
    kill $OPENCODE_PID 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
echo "OpenCode server is ready (took ${SECONDS}s)."

# ── Background repo updater (every hour) ──
# Pulls latest code and cleans repo agents/skills/plugins.
# Context regeneration is handled by the bot process (via OpenCode agent).
(
  while true; do
    sleep 3600
    echo "[repo-sync] Pulling latest ${TARGET_REPO}..."
    if git -C /app/repo pull --ff-only 2>&1 | sed 's/^/[repo-sync] /'; then
      echo "[repo-sync] Cleaning repo agent/skill/plugin files..."
      clean_repo_agents /app/repo
      cp /app/opencode.json /app/repo/opencode.json
      sed -i 's|"model": "[^"]*"|"model": "'"${PROVIDER}/${MODEL}"'"|' /app/repo/opencode.json
      echo "[repo-sync] Repo updated. Context regeneration will be triggered by the bot."
    else
      echo "[repo-sync] Pull failed, will retry next cycle."
    fi
  done
) &
echo "Background repo sync started (every 60 min)."

# ── Start the Slack bot ──
# The bot handles context generation on startup and every hour via the OpenCode context agent.
cd /app
exec node dist/index.js
