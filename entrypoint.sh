#!/bin/bash
set -e

# ── Provider configuration ──
PROVIDER="${PROVIDER:-github-copilot}"
MODEL="${MODEL:-claude-sonnet-4.6}"

# ── Neutralize the target repo's own agent/plugin/config files ──
# Some repos ship .opencode/agents/, .opencode/plugin/, .claude/agents/, etc.
# OpenCode auto-discovers these and they can override our read-only behavior or
# inject hooks, so we strip them after every clone/pull.
#
# We deliberately PRESERVE skills (.claude/skills/, .opencode/skill[s]/) and
# .claude/CLAUDE.md: skills are inert markdown surfaced to the agent via a
# generated manifest (see writeSkillManifest in src/skill-manifest.ts). Keep this
# in lockstep with cleanRepoAgents() in src/repo-manager.ts.
clean_repo_agents() {
  local repo="$1"
  echo "Cleaning repo agent/plugin/config files (preserving skills)..."
  rm -rf "$repo/.opencode/agents" "$repo/.opencode/agent"
  rm -rf "$repo/.opencode/plugin" "$repo/.opencode/plugins"
  rm -rf "$repo/.claude/agents" "$repo/.claude/commands" "$repo/.claude/hooks"
  rm -rf "$repo/.agents"
  # Remove nested .opencode config + claude settings that could override ours
  rm -f "$repo/.opencode/opencode.json"
  rm -f "$repo/.opencode/.opencode"
  rm -f "$repo/.claude/settings.json" "$repo/.claude/settings.local.json"
  echo "Repo agent/plugin/config files cleaned."
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
# Support legacy TARGET_REPO by constructing REPO_URL from it
if [ -z "$REPO_URL" ] && [ -n "$TARGET_REPO" ]; then
  REPO_URL="https://github.com/${TARGET_REPO}.git"
fi

if [ -z "$REPO_URL" ]; then
  echo "ERROR: REPO_URL is not set (e.g. REPO_URL=https://github.com/your-org/your-repo.git)"
  exit 1
fi

# Derive display name from URL if TARGET_REPO is not set
# e.g. https://gitlab.com/group/repo.git → group/repo
if [ -z "$TARGET_REPO" ]; then
  TARGET_REPO="$(echo "$REPO_URL" | sed -E 's|^https?://[^/]+/||; s|\.git$||')"
fi
export TARGET_REPO

# GIT_TOKEN with fallback to legacy GITHUB_TOKEN.
# Unset GITHUB_TOKEN afterward so OpenCode does not auto-detect the
# `github-models` provider — we route all LLM traffic through Bedrock.
GIT_TOKEN="${GIT_TOKEN:-$GITHUB_TOKEN}"
unset GITHUB_TOKEN

if [ -n "$GIT_TOKEN" ]; then
  # Use GIT_ASKPASS to supply credentials without embedding them in the URL
  # or persisting them in .git/config
  GIT_ASKPASS_SCRIPT="$(mktemp)"
  printf '#!/bin/sh\necho "%s"\n' "$GIT_TOKEN" > "$GIT_ASKPASS_SCRIPT"
  chmod +x "$GIT_ASKPASS_SCRIPT"
  export GIT_ASKPASS="$GIT_ASKPASS_SCRIPT"
  export GIT_TERMINAL_PROMPT=0
  # Authenticate gh CLI for PR creation in coding sessions
  export GH_TOKEN="$GIT_TOKEN"
else
  echo "WARNING: GIT_TOKEN is not set — clone may fail for private repos."
fi

if [ ! -d /app/repo/.git ]; then
  echo "Cloning ${TARGET_REPO}..."
  git clone "$REPO_URL" /app/repo
else
  # The checkout lives on persistent EFS. Two things rot it over time:
  #  1) Stale *.lock files under .git/refs (and index.lock) left by git processes
  #     killed mid-op — these block every pull ("Another git process is running"),
  #     freezing the repo on an old commit. Clear ONLY those — never gc.log.lock or
  #     objects/maintenance.lock, deleting which triggers a full repack that hangs boot.
  #  2) Files deleted from the working tree by a prior image version (e.g. skills) —
  #     a plain `git pull` won't restore them.
  # So: clear the blocking locks, fetch, then hard-reset to the remote default branch
  # to force the checkout to match origin exactly (restores skills, advances commit).
  find /app/repo/.git/refs -name '*.lock' -type f -delete 2>/dev/null || true
  rm -f /app/repo/.git/index.lock 2>/dev/null || true

  git -C /app/repo remote set-url origin "$REPO_URL"
  echo "Updating ${TARGET_REPO}..."
  if git -C /app/repo fetch origin 2>&1; then
    git -C /app/repo reset --hard '@{u}' || echo "Reset failed, continuing with existing checkout."
  else
    echo "Fetch failed, continuing with existing checkout."
  fi
fi

# ── Neutralize repo's own agents/plugins (skills preserved) ──
clean_repo_agents /app/repo

# ── Copy OpenCode rules and plugin into the repo directory ──
# opencode serve uses the cwd for config, so .opencode/rules/ and
# .opencode/plugin/ need to be present where the server runs.
# opencode.json is generated by Node on boot.
mkdir -p /app/repo/.opencode/rules
cp /app/.opencode/rules/*.md /app/repo/.opencode/rules/

# Copy the repo-scope plugin (enforces path constraints for multi-repo)
if [ -d /app/.opencode/plugin ]; then
  mkdir -p /app/repo/.opencode/plugin
  cp /app/.opencode/plugin/*.ts /app/repo/.opencode/plugin/
fi

# Copy plugin package.json for dependencies
if [ -f /app/.opencode/package.json ]; then
  cp /app/.opencode/package.json /app/repo/.opencode/package.json
fi

# ── Create directory for additional repos (multi-repo support) ──
mkdir -p /app/repos

# ── Create knowledge directory for S3-synced knowledge files ──
mkdir -p /app/knowledge

# ── Clean up orphaned coding session worktrees and processes ──
echo "Cleaning up orphaned coding sessions..."
# Prune worktrees on the default repo
git -C /app/repo worktree prune 2>/dev/null || true
# Remove leftover .worktrees directories
rm -rf /app/repo/.worktrees 2>/dev/null || true
for repo_dir in /app/repos/*/; do
  [ -d "${repo_dir}.git" ] || continue
  git -C "$repo_dir" worktree prune 2>/dev/null || true
  rm -rf "${repo_dir}.worktrees" 2>/dev/null || true
done
# Kill any OpenCode processes on coding session ports (4100+)
for pid in $(lsof -ti :4100-4200 2>/dev/null || true); do
  kill "$pid" 2>/dev/null || true
done
echo "Orphaned coding sessions cleaned up."

# ── Background repo updater (every hour) ──
# Pulls latest code and cleans repo agents/skills/plugins for all repos.
# Context regeneration is handled by the bot process (via OpenCode agent).
# Note: opencode.json is generated by Node on boot and on tool config changes,
# so we don't copy it here.
sync_repo() {
  local repo_dir="$1"
  local repo_name="$2"
  # If worktrees exist (coding sessions active), fetch only to avoid conflicts
  local wt_count
  wt_count=$(git -C "$repo_dir" worktree list --porcelain 2>/dev/null | grep -c '^worktree ' || echo 0)
  if [ "$wt_count" -gt 1 ]; then
    echo "[repo-sync] ${repo_name} has $((wt_count - 1)) active worktree(s) — fetching only."
    git -C "$repo_dir" fetch origin 2>&1 | sed 's/^/[repo-sync] /' || true
    return
  fi
  echo "[repo-sync] Pulling latest ${repo_name}..."
  if git -C "$repo_dir" pull --ff-only 2>&1 | sed 's/^/[repo-sync] /'; then
    echo "[repo-sync] Cleaning repo agent/skill/plugin files..."
    clean_repo_agents "$repo_dir"
    echo "[repo-sync] ${repo_name} updated."
  else
    echo "[repo-sync] Pull failed for ${repo_name}, will retry next cycle."
  fi
}

(
  while true; do
    sleep 3600
    # Sync default repo
    sync_repo /app/repo "${TARGET_REPO}"
    # Sync any additional repos under /app/repos/
    for repo_dir in /app/repos/*/; do
      [ -d "${repo_dir}.git" ] || continue
      repo_name="$(basename "$repo_dir")"
      sync_repo "$repo_dir" "$repo_name"
    done
    echo "[repo-sync] All repos synced. Context regeneration will be triggered by the bot."
  done
) &
echo "Background repo sync started (every 60 min)."

# ── Start the Slack bot ──
# The bot now manages the OpenCode server lifecycle (start, restart on config changes).
cd /app
exec node dist/index.js
