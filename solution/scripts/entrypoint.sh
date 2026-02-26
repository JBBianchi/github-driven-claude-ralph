#!/usr/bin/env bash
set -euo pipefail

ROLE="${1:?Usage: entrypoint.sh <planner|executor>}"

LOG_DIR="${AGENT_LOG_DIR:-/workspace/logs}"
mkdir -p "${LOG_DIR}" >/dev/null 2>&1 || true
ENTRYPOINT_LOG="${LOG_DIR}/entrypoint-${ROLE}.log"
exec > >(tee -a "${ENTRYPOINT_LOG}") 2>&1

is_truthy() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

rlm_fail_or_warn() {
  local message="$1"
  if is_truthy "${RLM_PLUGIN_REQUIRED}"; then
    echo "FATAL: ${message}"
    exit 1
  fi
  echo "WARNING: ${message}"
}

show_log_excerpt() {
  local path="$1"
  if [ -f "$path" ]; then
    echo "--- ${path} (last 80 lines) ---"
    tail -n 80 "$path"
    echo "--- end ${path} ---"
  fi
}

claude_plugin_cmd() {
  if claude plugin --help >/dev/null 2>&1; then
    claude plugin "$@"
    return
  fi
  claude plugins "$@"
}

plugin_installed() {
  local list_json=""
  if ! list_json="$(claude_plugin_cmd list --json 2>/tmp/rlm-plugin-list.log)"; then
    return 1
  fi

  if printf '%s' "$list_json" | jq -e --arg key "$RLM_PLUGIN_KEY" --arg name "$RLM_PLUGIN_NAME" \
    '.. | strings | select(. == $key or . == $name)' >/dev/null; then
    return 0
  fi

  return 1
}

add_marketplace() {
  local source="$1"
  local log_path="$2"
  if claude_plugin_cmd marketplace add "$source" >"$log_path" 2>&1; then
    return 0
  fi
  return 1
}

build_go_hook_binaries() {
  local plugin_dir="$1"
  local log_path="$2"

  if ! command -v go >/dev/null 2>&1; then
    return 1
  fi

  if ! (
    cd "$plugin_dir" &&
    mkdir -p bin &&
    go build -trimpath -ldflags="-s -w" -o bin/session-init ./cmd/session-init &&
    go build -trimpath -ldflags="-s -w" -o bin/complexity-check ./cmd/complexity-check &&
    go build -trimpath -ldflags="-s -w" -o bin/trajectory-save ./cmd/trajectory-save
  ) >"$log_path" 2>&1; then
    return 1
  fi

  return 0
}

rlm_core_importable() {
  local plugin_dir="$1"
  local log_path="$2"
  local python_bin="${plugin_dir}/.venv/bin/python3"

  if [ ! -x "${python_bin}" ]; then
    return 1
  fi

  if "${python_bin}" -c "import rlm_core; print(rlm_core.version())" >"${log_path}" 2>&1; then
    return 0
  fi

  return 1
}

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
echo "GitHub CLI version: $(gh --version | head -n 1)"
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
# 6. Optional RLM plugin setup (Claude Code plugin)
# =========================================================
RLM_PLUGIN_ENABLED="${RLM_PLUGIN_ENABLED:-true}"
RLM_PLUGIN_REQUIRED="${RLM_PLUGIN_REQUIRED:-true}"
RLM_PLUGIN_REF="${RLM_PLUGIN_REF:-rlm-claude-code@rlm-claude-code}"
RLM_PLUGIN_KEY="${RLM_PLUGIN_KEY:-rlm-claude-code@rlm-claude-code}"
RLM_PLUGIN_NAME="${RLM_PLUGIN_NAME:-${RLM_PLUGIN_REF%%@*}}"
RLM_PLUGIN_SCOPE="${RLM_PLUGIN_SCOPE:-user}"
RLM_MARKETPLACE_SOURCE="${RLM_MARKETPLACE_SOURCE:-rand/rlm-claude-code}"
RLM_ACTIVATION_MODE="${RLM_ACTIVATION_MODE:-complexity}"
RLM_CONFIG_PATH="${RLM_CONFIG_PATH:-/home/agent/.claude/rlm-config.json}"
RLM_DEBUG="${RLM_DEBUG:-0}"
RLM_PLUGIN_BUILD_HOOKS="${RLM_PLUGIN_BUILD_HOOKS:-true}"
RLM_PLUGIN_SYNC_REQUIRED="${RLM_PLUGIN_SYNC_REQUIRED:-true}"
RLM_PLUGIN_VERIFY_REQUIRED="${RLM_PLUGIN_VERIFY_REQUIRED:-true}"
export RLM_DEBUG
export RLM_CONFIG_PATH

if is_truthy "${RLM_PLUGIN_ENABLED}"; then
  RLM_BOOTSTRAP_STARTED_AT="$(date +%s)"
  echo "RLM plugin bootstrap enabled (${RLM_PLUGIN_REF})"

  if ! command -v uv >/dev/null 2>&1; then
    rlm_fail_or_warn "uv is required for RLM plugin setup but was not found"
  else
    if plugin_installed; then
      echo "RLM plugin already installed (${RLM_PLUGIN_KEY})"
    else
      MARKETPLACE_ADDED=false
      if add_marketplace "${RLM_MARKETPLACE_SOURCE}" "/tmp/rlm-plugin-marketplace.log"; then
        MARKETPLACE_ADDED=true
      elif [[ "${RLM_MARKETPLACE_SOURCE}" == github:* ]]; then
        RLM_MARKETPLACE_SOURCE_FALLBACK="${RLM_MARKETPLACE_SOURCE#github:}"
        if add_marketplace "${RLM_MARKETPLACE_SOURCE_FALLBACK}" "/tmp/rlm-plugin-marketplace.log"; then
          MARKETPLACE_ADDED=true
        fi
      fi

      if ! is_truthy "${MARKETPLACE_ADDED}"; then
        show_log_excerpt "/tmp/rlm-plugin-marketplace.log"
        rlm_fail_or_warn "failed to add marketplace source ${RLM_MARKETPLACE_SOURCE}"
      fi

      if ! claude_plugin_cmd install "${RLM_PLUGIN_REF}" --scope "${RLM_PLUGIN_SCOPE}" >/tmp/rlm-plugin-install.log 2>&1; then
        if ! claude_plugin_cmd install "${RLM_PLUGIN_NAME}" --scope "${RLM_PLUGIN_SCOPE}" >>/tmp/rlm-plugin-install.log 2>&1; then
          if ! plugin_installed; then
            show_log_excerpt "/tmp/rlm-plugin-marketplace.log"
            show_log_excerpt "/tmp/rlm-plugin-list.log"
            show_log_excerpt "/tmp/rlm-plugin-install.log"
            rlm_fail_or_warn "failed to install ${RLM_PLUGIN_REF} (scope=${RLM_PLUGIN_SCOPE})"
          fi
        fi
      fi
    fi

    RLM_PLUGIN_CACHE_ROOT="/home/agent/.claude/plugins/cache/rlm-claude-code/rlm-claude-code"
    RLM_PLUGIN_DIR="$(find "${RLM_PLUGIN_CACHE_ROOT}" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1)"

    if [ -z "${RLM_PLUGIN_DIR:-}" ] || [ ! -d "${RLM_PLUGIN_DIR}" ]; then
      rlm_fail_or_warn "could not find installed RLM plugin directory under ${RLM_PLUGIN_CACHE_ROOT}"
    else
      echo "RLM plugin directory: ${RLM_PLUGIN_DIR}"
      RLM_SYNC_OK=false
      RLM_CORE_OK=false

      if is_truthy "${RLM_PLUGIN_BUILD_HOOKS}"; then
        if [ -x "${RLM_PLUGIN_DIR}/bin/session-init" ] && [ -x "${RLM_PLUGIN_DIR}/bin/complexity-check" ] && [ -x "${RLM_PLUGIN_DIR}/bin/trajectory-save" ]; then
          echo "RLM hook binaries already present"
        elif build_go_hook_binaries "${RLM_PLUGIN_DIR}" "/tmp/rlm-plugin-hooks-build.log"; then
          echo "RLM hook binaries built successfully"
        else
          show_log_excerpt "/tmp/rlm-plugin-hooks-build.log"
          rlm_fail_or_warn "failed to build RLM hook binaries"
        fi
      else
        echo "Skipping RLM hook binary build (RLM_PLUGIN_BUILD_HOOKS=${RLM_PLUGIN_BUILD_HOOKS})"
      fi

      if is_truthy "${RLM_PLUGIN_SYNC_REQUIRED}" || is_truthy "${RLM_PLUGIN_VERIFY_REQUIRED}"; then
        if [ ! -x "${RLM_PLUGIN_DIR}/.venv/bin/python3" ]; then
          if ! (cd "${RLM_PLUGIN_DIR}" && uv venv --python 3.12) >/tmp/rlm-plugin-venv.log 2>&1; then
            if ! (cd "${RLM_PLUGIN_DIR}" && uv python install 3.12 && uv venv --python 3.12) >>/tmp/rlm-plugin-venv.log 2>&1; then
              show_log_excerpt "/tmp/rlm-plugin-venv.log"
              if is_truthy "${RLM_PLUGIN_SYNC_REQUIRED}"; then
                rlm_fail_or_warn "failed to create RLM plugin venv with Python 3.12"
              else
                echo "WARNING: failed to create RLM plugin venv with Python 3.12"
              fi
            fi
          fi
        fi

        if [ -x "${RLM_PLUGIN_DIR}/.venv/bin/python3" ]; then
          if rlm_core_importable "${RLM_PLUGIN_DIR}" "/tmp/rlm-core-version.log"; then
            RLM_SYNC_OK=true
            RLM_CORE_OK=true
            echo "RLM core already available ($(head -n 1 /tmp/rlm-core-version.log | tr -d '\r\n')); skipping uv sync"
          else
            RLM_SYNC_STARTED_AT="$(date +%s)"
            if (cd "${RLM_PLUGIN_DIR}" && uv sync) >/tmp/rlm-plugin-sync.log 2>&1; then
              RLM_SYNC_OK=true
              RLM_SYNC_ENDED_AT="$(date +%s)"
              echo "RLM dependency sync completed in $((RLM_SYNC_ENDED_AT - RLM_SYNC_STARTED_AT))s"
              if rlm_core_importable "${RLM_PLUGIN_DIR}" "/tmp/rlm-core-version.log"; then
                RLM_CORE_OK=true
              elif is_truthy "${RLM_PLUGIN_VERIFY_REQUIRED}"; then
                show_log_excerpt "/tmp/rlm-core-version.log"
                rlm_fail_or_warn "rlm_core import check failed after uv sync"
              fi
            else
              show_log_excerpt "/tmp/rlm-plugin-sync.log"
              if is_truthy "${RLM_PLUGIN_SYNC_REQUIRED}"; then
                rlm_fail_or_warn "failed to install RLM plugin dependencies"
              else
                echo "WARNING: failed to install RLM plugin dependencies; continuing with prebuilt plugin binaries"
              fi
            fi
          fi
        elif is_truthy "${RLM_PLUGIN_SYNC_REQUIRED}"; then
          rlm_fail_or_warn "plugin venv is unavailable and sync is required"
        fi
      else
        # Prevent plugin hook-dispatch from repeatedly trying uv sync in prebuilt-binary mode.
        mkdir -p "${RLM_PLUGIN_DIR}/.venv"
        echo "Skipping plugin Python dependency sync (RLM_PLUGIN_SYNC_REQUIRED=false)"
      fi

      if is_truthy "${RLM_PLUGIN_VERIFY_REQUIRED}" && ! is_truthy "${RLM_CORE_OK}"; then
        if ! rlm_core_importable "${RLM_PLUGIN_DIR}" "/tmp/rlm-core-version.log"; then
          show_log_excerpt "/tmp/rlm-core-version.log"
          rlm_fail_or_warn "rlm_core verification failed"
        else
          RLM_CORE_OK=true
        fi
      fi

      if [ ! -f "${RLM_PLUGIN_DIR}/scripts/legacy/merge-plugin-hooks.py" ]; then
        rlm_fail_or_warn "merge-plugin-hooks.py not found in plugin bundle"
      else
        mkdir -p /home/agent/.claude/scripts
        cp "${RLM_PLUGIN_DIR}/scripts/legacy/merge-plugin-hooks.py" /home/agent/.claude/scripts/merge-plugin-hooks.py

        SETTINGS_USER="/home/agent/.claude/settings.user.json"
        [ -f "${SETTINGS_USER}" ] || echo '{}' > "${SETTINGS_USER}"
        TMP_SETTINGS="$(mktemp)"
        jq '.enabledPlugins = (.enabledPlugins // {}) | .enabledPlugins["'"${RLM_PLUGIN_KEY}"'"] = true' "${SETTINGS_USER}" > "${TMP_SETTINGS}"
        mv "${TMP_SETTINGS}" "${SETTINGS_USER}"

        MERGE_PYTHON="python3"
        if [ -x "${RLM_PLUGIN_DIR}/.venv/bin/python3" ]; then
          MERGE_PYTHON="${RLM_PLUGIN_DIR}/.venv/bin/python3"
        fi

        if ! "${MERGE_PYTHON}" /home/agent/.claude/scripts/merge-plugin-hooks.py >/tmp/rlm-merge-hooks.log 2>&1; then
          show_log_excerpt "/tmp/rlm-merge-hooks.log"
          rlm_fail_or_warn "failed to merge plugin hooks into settings.json. See /tmp/rlm-merge-hooks.log"
        fi
      fi

      if [ ! -f "${RLM_CONFIG_PATH}" ]; then
        mkdir -p "$(dirname "${RLM_CONFIG_PATH}")"
        jq -n --arg mode "${RLM_ACTIVATION_MODE}" \
          '{activation:{mode:$mode,fallback_token_threshold:80000},depth:{default:2,max:3},trajectory:{verbosity:"normal",streaming:true}}' \
          > "${RLM_CONFIG_PATH}"
      fi

      SETTINGS_FILE="/home/agent/.claude/settings.json"
      if ! jq -e '.. | objects | select(._source? == "plugin:'"${RLM_PLUGIN_KEY}"'")' "${SETTINGS_FILE}" >/dev/null 2>&1; then
        rlm_fail_or_warn "RLM plugin hooks were not found in ${SETTINGS_FILE}"
      fi

      RLM_BOOTSTRAP_ENDED_AT="$(date +%s)"
      echo "RLM plugin bootstrap completed in $((RLM_BOOTSTRAP_ENDED_AT - RLM_BOOTSTRAP_STARTED_AT))s"
    fi
  fi
else
  echo "RLM plugin bootstrap disabled (RLM_PLUGIN_ENABLED=${RLM_PLUGIN_ENABLED})"
fi

# =========================================================
# 7. Claude CLI health check
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

if is_truthy "${RLM_PLUGIN_ENABLED}" && [ -n "${RLM_PLUGIN_DIR:-}" ] && [ -x "${RLM_PLUGIN_DIR}/scripts/hook-dispatch.sh" ]; then
  echo "RLM hook check..."
  RLM_HOOK_INPUT='{"session_id":"rlm-bootstrap-healthcheck","source":"startup","cwd":"/workspace"}'
  RLM_HOOK_OUT=$(printf '%s' "${RLM_HOOK_INPUT}" | CLAUDE_PLUGIN_ROOT="${RLM_PLUGIN_DIR}" "${RLM_PLUGIN_DIR}/scripts/hook-dispatch.sh" session-init 2>&1) || true
  echo "RLM hook check result: ${RLM_HOOK_OUT:0:200}"
  if [ -z "${RLM_HOOK_OUT//[[:space:]]/}" ]; then
    rlm_fail_or_warn "RLM hook check returned empty output"
  fi
  if [[ "${RLM_HOOK_OUT}" == *'"status":"skipped"'* || "${RLM_HOOK_OUT}" == *'"status": "skipped"'* || "${RLM_HOOK_OUT}" == *"attempted relative import with no known parent package"* ]]; then
    rlm_fail_or_warn "RLM hook check returned skipped/fallback output"
  fi
fi

# =========================================================
# 8. Hand off to TypeScript
# =========================================================
exec node /opt/agent/dist/index.js "$ROLE"
