#!/usr/bin/env bash
# Local dev runner: sets up env paths and a local checkout of the target repo,
# then hands off to `npm run dev`. Slackode itself spawns the opencode server
# (same behavior as prod via entrypoint.sh + opencode-server.ts).

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

# Load .env (export every assignment).
if [ ! -f .env ]; then
  echo "ERROR: .env not found in $ROOT" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# Resolve repo location. Default to ./.local/repo (gitignored area).
: "${REPO_DIR:=$ROOT/.local/repo}"
: "${REPOS_BASE_DIR:=$ROOT/.local/repos}"
: "${SESSIONS_DB_PATH:=$ROOT/.local/sessions.db}"
: "${BASE_CONFIG_PATH:=$ROOT/opencode.json}"
: "${TOOLS_SEED_PATH:=$ROOT/tools.json}"
export REPO_DIR REPOS_BASE_DIR SESSIONS_DB_PATH BASE_CONFIG_PATH TOOLS_SEED_PATH

mkdir -p "$(dirname "$SESSIONS_DB_PATH")" "$REPOS_BASE_DIR"

if [ -z "${REPO_URL:-}" ]; then
  echo "ERROR: REPO_URL not set in .env" >&2
  exit 1
fi

# Clone the target repo if missing.
if [ ! -d "$REPO_DIR/.git" ]; then
  echo "[dev] Cloning $REPO_URL into $REPO_DIR ..."
  GIT_TOKEN="${GIT_TOKEN:-${GITHUB_TOKEN:-}}"
  if [ -n "$GIT_TOKEN" ]; then
    GIT_ASKPASS_SCRIPT="$(mktemp)"
    printf '#!/bin/sh\necho "%s"\n' "$GIT_TOKEN" > "$GIT_ASKPASS_SCRIPT"
    chmod +x "$GIT_ASKPASS_SCRIPT"
    export GIT_ASKPASS="$GIT_ASKPASS_SCRIPT"
    export GIT_TERMINAL_PROMPT=0
  fi
  git clone "$REPO_URL" "$REPO_DIR"
fi

# Pin opencode to a specific version when a binary is parked at
# .local/bin/opencode-<ver>. Override with OPENCODE_PIN=<ver>; falls back to the
# system opencode (whatever is on PATH) when no pinned binary is found.
DEFAULT_OPENCODE_PIN="1.15.13"
PIN="${OPENCODE_PIN:-$DEFAULT_OPENCODE_PIN}"
if [ -x "$ROOT/.local/bin/opencode-$PIN" ]; then
  ln -sf "$ROOT/.local/bin/opencode-$PIN" "$ROOT/.local/bin/opencode"
  export PATH="$ROOT/.local/bin:$PATH"
  echo "[dev] Using PINNED opencode: $($ROOT/.local/bin/opencode --version)"
else
  echo "[dev] Pin $PIN not found at .local/bin/opencode-$PIN; using system opencode: $(command -v opencode >/dev/null 2>&1 && opencode --version || echo 'not found')"
fi

# Verify opencode is installed (slackode will spawn it).
if ! command -v opencode >/dev/null 2>&1; then
  echo "ERROR: opencode CLI not found in PATH. Install from https://opencode.ai" >&2
  exit 1
fi

# Resolve AWS credentials from the user's active CLI session (SSO / login wrapper / static).
# Slackode → opencode inherit env, so this puts Bedrock auth in reach of the @ai-sdk/amazon-bedrock provider.
if [ "${PROVIDER:-}" = "amazon-bedrock" ]; then
  if command -v aws >/dev/null 2>&1; then
    if AWS_CREDS=$(aws configure export-credentials --format env 2>/dev/null); then
      # Output looks like: `export AWS_ACCESS_KEY_ID=...` for each var. Source it.
      eval "$AWS_CREDS"
      echo "[dev] Loaded AWS credentials from CLI session (expires ${AWS_CREDENTIAL_EXPIRATION:-unknown})."
    else
      echo "[dev] WARNING: 'aws configure export-credentials' failed — run your AWS login first." >&2
    fi
  else
    echo "[dev] WARNING: aws CLI not found; Bedrock calls will fail without AWS_ACCESS_KEY_ID/SECRET in .env." >&2
  fi
fi

echo "[dev] Starting slackode (tsx, no npm wrapper) — it will spawn opencode itself."
echo
# Run tsx directly (not via npm) so SIGINT propagates to node cleanly and slackode's
# shutdown handler can run to completion before the process is killed.
exec ./node_modules/.bin/tsx src/index.ts
