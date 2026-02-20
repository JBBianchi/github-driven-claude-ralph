#!/usr/bin/env bash
set -euo pipefail

GITHUB_PAT_SECRET_PATH="${GITHUB_PAT_SECRET_PATH:-/run/secrets/github_pat}"

# Optional: authenticate gh from a mounted Docker secret.
# This avoids passing PATs through environment variables.
if command -v gh >/dev/null 2>&1; then
    gh_authenticated=false

    if gh auth status >/dev/null 2>&1; then
        gh_authenticated=true
    elif [[ -f "$GITHUB_PAT_SECRET_PATH" ]]; then
        token="$(tr -d '\r\n' < "$GITHUB_PAT_SECRET_PATH")"
        if [[ -n "$token" ]]; then
            if printf '%s' "$token" | gh auth login --with-token >/dev/null 2>&1; then
                gh_authenticated=true
            else
                echo "Warning: failed to authenticate gh using secret at $GITHUB_PAT_SECRET_PATH" >&2
            fi
        fi
        unset token
    fi

    # Configure git to use gh credentials so https clone/pull does not prompt.
    if [[ "$gh_authenticated" == "true" ]]; then
        if ! gh auth setup-git >/dev/null 2>&1; then
            echo "Warning: gh authenticated but failed to run 'gh auth setup-git'" >&2
        fi
    fi
fi

exec "$@"
