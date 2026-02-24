#!/usr/bin/env bash
set -euo pipefail

ROLE="${1:?Usage: entrypoint.sh <planner|executor>}"

# =========================================================
# 1. GitHub token (from Docker secret or env var fallback)
# =========================================================
GH_TOKEN_FILE="/run/secrets/GH_TOKEN"
if [ -f "$GH_TOKEN_FILE" ]; then
  GH_TOKEN="$(cat "$GH_TOKEN_FILE")"
  export GH_TOKEN
  export GITHUB_TOKEN="$GH_TOKEN"
elif [ -n "${GH_TOKEN:-}" ]; then
  export GITHUB_TOKEN="$GH_TOKEN"
elif [ -n "${GITHUB_TOKEN:-}" ]; then
  export GH_TOKEN="$GITHUB_TOKEN"
fi
[ -z "${GH_TOKEN:-}" ] && echo "FATAL: No GitHub token (mount as secret or set GH_TOKEN)" && exit 1

# =========================================================
# 2. Git identity
# =========================================================
git config --global user.name  "${GIT_AUTHOR_NAME:?GIT_AUTHOR_NAME required}"
git config --global user.email "${GIT_AUTHOR_EMAIL:?GIT_AUTHOR_EMAIL required}"

# Git HTTPS auth via token
git config --global url."https://${GH_TOKEN}@github.com/".insteadOf "https://github.com/"

# =========================================================
# 3. Signing key import (copy from mount, never use in-place)
# =========================================================
SIGNING_MODE="${GIT_COMMIT_SIGNING:-off}"
KEYS_MOUNT="${SIGNING_KEYS_MOUNT:-/mnt/host-keys}"

case "$SIGNING_MODE" in
  gpg)
    echo "Configuring GPG signing..."
    GPG_KEY_SRC="${KEYS_MOUNT}/gpg_private_key.asc"
    GPG_KEY_DST="/home/agent/.gnupg/import.asc"
    mkdir -p /home/agent/.gnupg
    chmod 700 /home/agent/.gnupg
    if [ -f "$GPG_KEY_SRC" ]; then
      # Copy and fix Windows CRLF line endings + BOM
      tr -d '\r' < "$GPG_KEY_SRC" > "$GPG_KEY_DST"
      sed -i '1s/^\xEF\xBB\xBF//' "$GPG_KEY_DST"
      gpg --batch --import "$GPG_KEY_DST"
      rm -f "$GPG_KEY_DST"
    else
      echo "FATAL: GPG signing enabled but ${GPG_KEY_SRC} not found" && exit 1
    fi
    git config --global commit.gpgsign true
    git config --global user.signingkey "${GIT_SIGNING_KEY:?GIT_SIGNING_KEY required for GPG signing}"
    export GPG_TTY=$(tty 2>/dev/null || echo "/dev/console")
    echo "GPG signing configured (key: ${GIT_SIGNING_KEY})"
    ;;
  ssh)
    echo "Configuring SSH signing..."
    SSH_KEY_SRC="${KEYS_MOUNT}/ssh_signing_key"
    SSH_PUB_SRC="${KEYS_MOUNT}/ssh_signing_key.pub"
    SSH_KEY_DST="/home/agent/.ssh/signing_key"
    SSH_PUB_DST="/home/agent/.ssh/signing_key.pub"
    mkdir -p /home/agent/.ssh
    chmod 700 /home/agent/.ssh
    if [ -f "$SSH_KEY_SRC" ] && [ -f "$SSH_PUB_SRC" ]; then
      cp "$SSH_KEY_SRC" "$SSH_KEY_DST"
      cp "$SSH_PUB_SRC" "$SSH_PUB_DST"
      chmod 600 "$SSH_KEY_DST"
      chmod 644 "$SSH_PUB_DST"
    else
      echo "FATAL: SSH signing enabled but key files not found in ${KEYS_MOUNT}" && exit 1
    fi
    git config --global gpg.format ssh
    git config --global commit.gpgsign true
    git config --global user.signingkey "$SSH_PUB_DST"
    echo "SSH signing configured"
    ;;
  off)
    echo "Commit signing disabled"
    git config --global commit.gpgsign false
    ;;
  *)
    echo "FATAL: Unknown GIT_COMMIT_SIGNING value: ${SIGNING_MODE} (expected: off|gpg|ssh)" && exit 1
    ;;
esac

# =========================================================
# 4. Verify gh CLI authentication
# =========================================================
# gh uses the GH_TOKEN env var automatically; just verify it works
gh auth status

# =========================================================
# 5. Validate Claude credentials
# =========================================================
CLAUDE_CREDS="/home/agent/.claude/.credentials.json"
if [ ! -f "$CLAUDE_CREDS" ]; then
  echo "FATAL: Claude credentials file not found at ${CLAUDE_CREDS}"
  echo "Mount your credentials file via: -v /path/to/.credentials.json:${CLAUDE_CREDS}:ro"
  exit 1
fi
echo "Claude credentials file found ($(wc -c < "$CLAUDE_CREDS") bytes)"

# =========================================================
# 6. Claude CLI health check
# =========================================================
echo "Claude CLI version: $(claude --version 2>&1 || echo 'UNKNOWN')"
echo "Claude CLI health check..."
HEALTH_OUT=$(claude -p "respond with just the word ok" --dangerously-skip-permissions --output-format text --max-turns 1 2>&1) || true
echo "Claude health check result: ${HEALTH_OUT:0:200}"
if [ "$HEALTH_OUT" = "Execution error" ]; then
  echo "ERROR: Claude CLI returning 'Execution error'. Dumping diagnostics..."
  echo "  HOME=$HOME"
  echo "  Claude config dir: $(ls -la /home/agent/.claude/ 2>&1)"
  echo "  Credentials file type: $(file "$CLAUDE_CREDS" 2>&1)"
  echo "  Node version: $(node --version)"
  echo "  Claude binary: $(which claude) -> $(readlink -f "$(which claude)" 2>/dev/null || echo 'not a symlink')"
fi

# =========================================================
# 7. Hand off to TypeScript
# =========================================================
exec node /opt/agent/dist/index.js "$ROLE"
