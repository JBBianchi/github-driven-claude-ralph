# Dockerized Planner/Executor — Revised Plan

Date: 2026-02-22

## 1) Philosophy

Claude Code already knows how to use `gh`, `git`, read code, write code, and reason about
GitHub issues. We don't need to reimplement those capabilities in custom adapters.

This plan builds **thin bash harnesses** that handle the boring deterministic work
(loops, timing, credential setup, worktree management) and delegate all reasoning to
Claude Code invoked in `-p` (print/headless) mode with role-specific prompts.

The complexity lives in the **prompts**, not the code.

## 2) Architecture overview

```
┌─────────────────────────────────────────────────────────┐
│  Docker image  (one image, two entrypoint commands)     │
│                                                         │
│  Installed: node, claude code, git, gh, gpg             │
│                                                         │
│  entrypoint.sh                                          │
│    ├── read secrets (token, GPG key)                    │
│    ├── configure git identity + signing                 │
│    ├── authenticate gh CLI                              │
│    └── exec planner-loop.sh | executor-loop.sh          │
│                                                         │
│  planner-loop.sh              executor-loop.sh          │
│    while true:                  while true:             │
│      sync repo                    sync repo             │
│      claude -p <planner>          find/claim task (gh)  │
│      sleep                        setup worktree        │
│                                   claude -p <executor>  │
│                                   monitor PR (gh)       │
│                                   sleep                 │
│                                                         │
│  Claude does the thinking:                              │
│    reads issues, writes plans, writes code,             │
│    creates PRs, commits, pushes                         │
└─────────────────────────────────────────────────────────┘
```

## 3) Responsibility split: bash vs Claude

### Bash handles (deterministic, cheap, reliable)

- Loop timing and sleep intervals
- Credential setup (GPG import, git config, gh auth)
- Repo sync (`git fetch`, `git reset`)
- Task claiming and label transitions (`gh issue edit`)
- Worktree creation/reuse (`git worktree add`)
- PR status polling (`gh pr view`, `gh pr checks`)
- PR merging (`gh pr merge`)
- Cost controls (max turns, budget caps, rate limits)
- State files (active task ID, session ID)

### Claude handles (reasoning, creative, expensive)

- Reading feature issues and understanding requirements
- Analyzing the codebase to produce plans
- Writing plan issue content
- Decomposing plans into task issues
- Reading task issues and understanding what to build
- Writing code
- Running validation commands
- Staging, committing, and pushing changes
- Writing PR descriptions
- Diagnosing CI failures and fixing code

## 4) File layout

```
Dockerfile
docker-compose.yml
.env.example
scripts/
  entrypoint.sh             # credential/identity setup, then exec loop
  planner-loop.sh           # planner outer loop
  executor-loop.sh          # executor outer loop
  lib.sh                    # shared bash functions
prompts/
  planner.md                # appended system prompt for planner role
  executor-implement.md     # appended system prompt for executor (code phase)
  executor-plan-task.md     # appended system prompt for executor (plan reading)
secrets/                    # gitignored, mounted at runtime
  github_token.txt
  gpg_private_key.asc       # optional, armored export from Windows
  gpg_passphrase.txt        # optional
```

## 5) Dockerfile

Single-stage image based on `node:20`. Installs:

- `@anthropic-ai/claude-code` (npm, pinned version)
- `git`, `gh` (GitHub CLI), `gpg`, `jq`
- Non-root user `agent` with home at `/home/agent`

```dockerfile
FROM node:20-slim

ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update && apt-get install -y --no-install-recommends \
    git gh gpg gpg-agent jq curl ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

RUN useradd -m -s /bin/bash agent
RUN mkdir -p /workspace/repo /workspace/worktrees /workspace/state \
    && chown -R agent:agent /workspace

COPY --chmod=755 scripts/ /opt/agent/scripts/
COPY prompts/ /opt/agent/prompts/

USER agent
WORKDIR /workspace

ENV DISABLE_AUTOUPDATER=1
ENV DISABLE_NONESSENTIAL_TRAFFIC=1

ENTRYPOINT ["/opt/agent/scripts/entrypoint.sh"]
```

Key choices:
- `node:20-slim` not `node:20` — smaller image, we don't need build tools
- `gh` installed via apt (available in Debian repos) — used by both bash and Claude
- Non-root `agent` user for security
- `/workspace/` as the working root, matching the volume contract
- Auto-updater disabled for deterministic container builds

## 6) docker-compose.yml

```yaml
services:
  planner:
    build: .
    command: ["planner"]
    restart: unless-stopped
    environment:
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      REPO_URL: ${REPO_URL}
      REPO_SLUG: ${REPO_SLUG}
      BASE_BRANCH: ${BASE_BRANCH:-main}
      GIT_AUTHOR_NAME: ${GIT_AUTHOR_NAME}
      GIT_AUTHOR_EMAIL: ${GIT_AUTHOR_EMAIL}
      GITHUB_TOKEN_FILE: /run/secrets/github_token
      POLL_INTERVAL: ${PLANNER_POLL_INTERVAL:-120}
      MAX_TURNS_PER_RUN: ${PLANNER_MAX_TURNS:-30}
      ENABLE_GPG_SIGNING: ${ENABLE_GPG_SIGNING:-false}
      GPG_KEY_ID: ${GPG_KEY_ID:-}
    volumes:
      - repo_data:/workspace/repo
      - state_data:/workspace/state
    secrets:
      - github_token
      - gpg_private_key

  executor:
    build: .
    command: ["executor"]
    restart: unless-stopped
    environment:
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      REPO_URL: ${REPO_URL}
      REPO_SLUG: ${REPO_SLUG}
      BASE_BRANCH: ${BASE_BRANCH:-main}
      GIT_AUTHOR_NAME: ${GIT_AUTHOR_NAME}
      GIT_AUTHOR_EMAIL: ${GIT_AUTHOR_EMAIL}
      GITHUB_TOKEN_FILE: /run/secrets/github_token
      EXECUTOR_ID: ${EXECUTOR_ID:-executor-01}
      POLL_INTERVAL: ${EXECUTOR_POLL_INTERVAL:-60}
      MAX_TURNS_PER_RUN: ${EXECUTOR_MAX_TURNS:-50}
      VALIDATION_COMMAND: ${VALIDATION_COMMAND:-}
      ENABLE_GPG_SIGNING: ${ENABLE_GPG_SIGNING:-false}
      GPG_KEY_ID: ${GPG_KEY_ID:-}
    volumes:
      - repo_data:/workspace/repo
      - worktrees_data:/workspace/worktrees
      - state_data:/workspace/state
    secrets:
      - github_token
      - gpg_private_key

volumes:
  repo_data:
  worktrees_data:
  state_data:

secrets:
  github_token:
    file: ./secrets/github_token.txt
  gpg_private_key:
    file: ./secrets/gpg_private_key.asc
```

## 7) entrypoint.sh

Runs before the loop starts. Handles all credential/identity setup.

```bash
#!/usr/bin/env bash
set -euo pipefail

ROLE="${1:?Usage: entrypoint.sh <planner|executor>}"

# --- Load GitHub token ---
if [ -f "${GITHUB_TOKEN_FILE:-}" ]; then
  GITHUB_TOKEN=$(cat "$GITHUB_TOKEN_FILE")
  export GITHUB_TOKEN
  export GH_TOKEN="$GITHUB_TOKEN"
fi
[ -z "${GITHUB_TOKEN:-}" ] && echo "FATAL: No GitHub token" && exit 1

# --- Git identity ---
git config --global user.name  "${GIT_AUTHOR_NAME:?}"
git config --global user.email "${GIT_AUTHOR_EMAIL:?}"

# --- Git auth (HTTPS token) ---
git config --global url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"

# --- GPG signing (optional) ---
if [ "${ENABLE_GPG_SIGNING:-false}" = "true" ]; then
  KEY_FILE="/run/secrets/gpg_private_key"
  if [ -f "$KEY_FILE" ]; then
    # Fix Windows CRLF line endings before import
    tr -d '\r' < "$KEY_FILE" | gpg --batch --import
    git config --global commit.gpgsign true
    git config --global user.signingkey "${GPG_KEY_ID:?GPG_KEY_ID required when signing enabled}"
    # Allow gpg in containers without a real tty
    export GPG_TTY=$(tty 2>/dev/null || echo "/dev/console")
    echo "GPG signing configured (key: ${GPG_KEY_ID})"
  else
    echo "FATAL: GPG signing enabled but key file missing" && exit 1
  fi
fi

# --- gh CLI auth ---
echo "$GITHUB_TOKEN" | gh auth login --with-token

# --- Launch loop ---
exec "/opt/agent/scripts/${ROLE}-loop.sh"
```

## 8) Planner loop

`scripts/planner-loop.sh` — the outer loop is simple; Claude does the real work.

```bash
#!/usr/bin/env bash
set -euo pipefail
source /opt/agent/scripts/lib.sh

echo "=== Planner starting (repo: ${REPO_SLUG}, interval: ${POLL_INTERVAL}s) ==="

while true; do
  sync_repo

  # Count features needing plans
  count=$(gh issue list -R "$REPO_SLUG" -l "feature,needs-plan" --json number --jq 'length')

  if [ "$count" -gt 0 ]; then
    echo "[$(date -Is)] Found $count feature(s) needing plans"

    claude -p \
      "$(build_planner_context)" \
      --append-system-prompt-file /opt/agent/prompts/planner.md \
      --dangerously-skip-permissions \
      --max-turns "${MAX_TURNS_PER_RUN}" \
      --output-format text \
      --verbose \
      2>&1 | tee -a /workspace/state/planner.log

    echo "[$(date -Is)] Planner run complete"
  else
    echo "[$(date -Is)] No features need planning. Sleeping."
  fi

  sleep "$POLL_INTERVAL"
done
```

The `build_planner_context` function (in `lib.sh`) constructs the user prompt:

```bash
build_planner_context() {
  cat <<EOF
You are the Planner agent for repository ${REPO_SLUG}.
Working directory: /workspace/repo (synced to ${BASE_BRANCH})

Find all GitHub issues labeled "feature" + "needs-plan" and process them.
Use \`gh\` for all GitHub API operations.
EOF
}
```

The actual planning instructions (what to do, what labels to set, how to format plans)
live in `prompts/planner.md`, passed via `--append-system-prompt-file`.

## 9) Executor loop

`scripts/executor-loop.sh` — more complex because it manages worktrees and task lifecycle.

```bash
#!/usr/bin/env bash
set -euo pipefail
source /opt/agent/scripts/lib.sh

STATE_DIR="/workspace/state/executor/${EXECUTOR_ID}"
mkdir -p "$STATE_DIR"

echo "=== Executor ${EXECUTOR_ID} starting (repo: ${REPO_SLUG}) ==="

while true; do
  sync_repo

  active_task=$(cat "$STATE_DIR/active_task" 2>/dev/null || echo "")

  # --- Phase 1: Resume or claim a task ---
  if [ -z "$active_task" ]; then
    active_task=$(claim_next_task)
    if [ -z "$active_task" ]; then
      echo "[$(date -Is)] No tasks available. Sleeping."
      sleep "$POLL_INTERVAL"
      continue
    fi
    echo "$active_task" > "$STATE_DIR/active_task"
  fi

  echo "[$(date -Is)] Working on task #${active_task}"
  task_title=$(gh issue view "$active_task" -R "$REPO_SLUG" --json title --jq '.title')
  task_body=$(gh issue view "$active_task" -R "$REPO_SLUG" --json body --jq '.body')

  # --- Phase 2: Ensure worktree ---
  branch="task/${active_task}-$(slugify "$task_title")"
  worktree="/workspace/worktrees/${active_task}"
  ensure_worktree "$active_task" "$branch" "$worktree"

  # --- Phase 3: Claude implements ---
  session_file="$STATE_DIR/session_${active_task}"
  resume_flag=""
  if [ -f "$session_file" ]; then
    resume_flag="--resume $(cat "$session_file")"
  fi

  claude -p \
    "$(build_executor_context "$active_task" "$task_title" "$task_body")" \
    --append-system-prompt-file /opt/agent/prompts/executor-implement.md \
    --dangerously-skip-permissions \
    --max-turns "${MAX_TURNS_PER_RUN}" \
    --output-format json \
    $resume_flag \
    2>&1 | tee "$STATE_DIR/run_${active_task}.log" \
    | jq -r '.session_id // empty' > "$session_file.tmp"

  # Save session ID for resume on next iteration
  [ -s "$session_file.tmp" ] && mv "$session_file.tmp" "$session_file"

  # --- Phase 4: Check PR and merge ---
  pr_number=$(gh pr list -R "$REPO_SLUG" --head "$branch" --json number --jq '.[0].number // empty')

  if [ -n "$pr_number" ]; then
    pr_status=$(check_pr_status "$pr_number")
    case "$pr_status" in
      mergeable)
        echo "[$(date -Is)] PR #${pr_number} ready — merging"
        gh pr merge "$pr_number" -R "$REPO_SLUG" --squash --delete-branch
        gh issue edit "$active_task" -R "$REPO_SLUG" \
          --add-label "done" --remove-label "in-progress,claimed-by:${EXECUTOR_ID}"
        gh issue close "$active_task" -R "$REPO_SLUG"
        complete_task "$active_task"
        ;;
      failing)
        echo "[$(date -Is)] PR #${pr_number} checks failing — will retry next iteration"
        ;;
      pending)
        echo "[$(date -Is)] PR #${pr_number} checks pending — will check next iteration"
        ;;
    esac
  else
    echo "[$(date -Is)] No PR yet for task #${active_task} — will continue next iteration"
  fi

  sleep "$POLL_INTERVAL"
done
```

## 10) Shared library (lib.sh)

```bash
#!/usr/bin/env bash

sync_repo() {
  if [ ! -d /workspace/repo/.git ]; then
    echo "[$(date -Is)] Cloning ${REPO_URL}..."
    git clone "${REPO_URL}" /workspace/repo
  fi
  git -C /workspace/repo fetch origin
  git -C /workspace/repo checkout "${BASE_BRANCH}"
  git -C /workspace/repo reset --hard "origin/${BASE_BRANCH}"
}

claim_next_task() {
  local task_id
  task_id=$(gh issue list -R "$REPO_SLUG" -l "task,todo" \
    --json number --jq '.[0].number // empty' 2>/dev/null)
  if [ -n "$task_id" ]; then
    # Claim: swap labels
    gh issue edit "$task_id" -R "$REPO_SLUG" \
      --add-label "in-progress,claimed-by:${EXECUTOR_ID}" \
      --remove-label "todo"
    # Verify claim succeeded
    local labels
    labels=$(gh issue view "$task_id" -R "$REPO_SLUG" --json labels --jq '[.labels[].name] | join(",")')
    if echo "$labels" | grep -q "claimed-by:${EXECUTOR_ID}"; then
      echo "$task_id"
      return
    fi
  fi
  echo ""
}

ensure_worktree() {
  local task_id="$1" branch="$2" worktree="$3"
  if [ -d "$worktree" ]; then
    echo "[$(date -Is)] Reusing existing worktree at $worktree"
    git -C "$worktree" fetch origin
    return
  fi
  # Check if branch exists on remote
  if git -C /workspace/repo ls-remote --heads origin "$branch" | grep -q "$branch"; then
    git -C /workspace/repo worktree add "$worktree" "origin/$branch"
  else
    git -C /workspace/repo worktree add "$worktree" -b "$branch" "origin/${BASE_BRANCH}"
  fi
}

complete_task() {
  local task_id="$1"
  rm -f "$STATE_DIR/active_task" "$STATE_DIR/session_${task_id}"
  echo "[$(date -Is)] Task #${task_id} complete"
}

check_pr_status() {
  local pr="$1"
  local state
  state=$(gh pr view "$pr" -R "$REPO_SLUG" --json mergeable,reviewDecision,statusCheckRollup \
    --jq '{
      mergeable: .mergeable,
      review: .reviewDecision,
      checks: [.statusCheckRollup[]?.conclusion // "PENDING"] | unique
    }')
  local checks
  checks=$(echo "$state" | jq -r '.checks | join(",")')
  local mergeable
  mergeable=$(echo "$state" | jq -r '.mergeable')

  if [ "$mergeable" = "MERGEABLE" ] && ! echo "$checks" | grep -qiE "pending|null"; then
    echo "mergeable"
  elif echo "$checks" | grep -qi "failure"; then
    echo "failing"
  else
    echo "pending"
  fi
}

slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | head -c 40
}

build_executor_context() {
  local task_id="$1" title="$2" body="$3"
  cat <<EOF
You are the Executor agent for repository ${REPO_SLUG}.
Working directory: /workspace/worktrees/${task_id} (branch for this task)
Task issue: #${task_id} — ${title}

Task description:
${body}

Implement the changes described in this task.
EOF
}
```

## 11) Prompts (the actual brain)

These are the most important files in the project. They tell Claude what to do.

### prompts/planner.md

```markdown
# Planner Agent Instructions

You are the planning agent. Your job is to turn feature requests into actionable plans
and decompose approved plans into individual task issues.

## Per feature issue (labeled "feature" + "needs-plan"):

### Step 1 — Check for existing plan
Search for an issue titled "Plan: <feature title>" or with metadata block
containing `source_feature: <number>`. If it exists, reuse it.

### Step 2 — Create or update the plan issue
- Title: "Plan: <feature title>"
- Labels: `plan:draft`
- Body must include:
  - Summary of the feature
  - Analysis of affected files/components (read the codebase!)
  - Ordered checklist of implementation tasks
  - Metadata block (see format below)

### Step 3 — Assess plan readiness
- If you need human input to proceed, add label `plan:needs-clarification`
  and comment explaining what you need. Stop processing this feature.
- If the plan is clear and complete, add label `plan:ready`.

### Step 4 — Create task issues (only when plan has `plan:ready`)
For each checklist item in the plan:
- Create an issue titled "Task: <description>"
- Labels: `task`, `todo`
- Body: detailed requirements, relevant file paths, acceptance criteria
- Include metadata block linking back to the plan issue
After all tasks created:
- Update plan label to `plan:tasks-created`
- Update feature issue: remove `needs-plan`, add `planned`
- Update plan checklist items with links to created task issues

## Metadata block format
Embed this HTML comment in every issue you create:
<!-- agent-meta
entity: plan|task
source_feature: <feature_issue_number>
source_plan: <plan_issue_number>  (tasks only)
-->

## Rules
- NEVER create duplicate plans or tasks. Always search first.
- Use `gh issue list`, `gh issue create`, `gh issue edit`, `gh issue view`.
- Read the codebase to make informed plans. Use `find`, `cat`, `grep` as needed.
- Keep plans concrete and implementable — reference specific files and functions.
```

### prompts/executor-implement.md

```markdown
# Executor Agent Instructions

You are the executor agent. You implement code changes for a single task.

## Your environment
- You are in a git worktree checked out to a feature branch
- The branch is based on the latest main branch
- You have full access to the codebase

## Your job
1. Read and understand the task requirements (provided in the prompt)
2. Read relevant source files to understand existing code
3. Implement the required changes
4. Run validation if a command is specified: ${VALIDATION_COMMAND}
5. If validation fails, fix the issues and retry
6. Stage and commit your changes with a clear conventional commit message
7. Push the branch: `git push -u origin HEAD`
8. Create a PR (or update existing) using `gh pr create`:
   - Title: concise description of the change
   - Body: what changed, why, link to task issue (#<number>)
   - Labels: `task:<task_id>`

## Rules
- Make focused, minimal changes. Don't refactor unrelated code.
- Write code that matches the existing style and conventions.
- Commit messages: use conventional commits (feat:, fix:, refactor:, etc.)
- If you're stuck or the task is unclear, comment on the issue explaining
  what's blocking you and stop.
- Do NOT merge the PR. The orchestrator handles merging.
- Do NOT modify labels. The orchestrator handles label transitions.
```

## 12) Label protocol

Same as the user's original draft, kept minimal:

| Label | Applied by | Meaning |
|-------|-----------|---------|
| `feature` | Human | This issue is a feature request |
| `needs-plan` | Human | Feature needs a plan |
| `planned` | Planner | Plan and tasks created |
| `plan:draft` | Planner | Plan exists, not yet approved |
| `plan:needs-clarification` | Planner | Human input needed |
| `plan:ready` | Human/Planner | Plan approved, tasks can be created |
| `plan:tasks-created` | Planner | All task issues created |
| `task` | Planner | This issue is an implementation task |
| `todo` | Planner | Task available for claiming |
| `in-progress` | Executor (bash) | Task claimed and being worked on |
| `claimed-by:<id>` | Executor (bash) | Which executor owns this task |
| `done` | Executor (bash) | Task complete, PR merged |
| `blocked` | Executor | Task needs human intervention |

Labels are created automatically if missing. The entrypoint or first loop iteration
can call `gh label create` with `--force` for each required label.

## 13) Cost and safety controls

### Per-invocation limits
- `--max-turns N`: caps how many tool calls Claude makes per run
  - Planner: 30 turns (enough to process several features)
  - Executor: 50 turns (implementation may need many file edits)
- These are configurable via `MAX_TURNS_PER_RUN` env var

### Rate limiting (bash)
- Planner sleeps 2 minutes between runs by default
- Executor sleeps 1 minute between runs by default
- When no work is available, both skip the Claude invocation entirely (free)

### Guardrails in prompts
- Planner prompt: "NEVER create duplicates. Always search first."
- Executor prompt: "Make focused, minimal changes."
- Both: if stuck, comment and stop rather than looping

### Future additions (not v1)
- `--max-budget-usd` per invocation
- Hourly call counter (like ralph-claude-code's rate limiter)
- Circuit breaker for repeated failures

## 14) GPG signing from Windows

The user's GPG keys live on a Windows host. The entrypoint handles this:

1. Export armored private key on Windows:
   `gpg --armor --export-secret-keys <KEY_ID> > secrets/gpg_private_key.asc`

2. The file is mounted via Docker secrets into `/run/secrets/gpg_private_key`

3. `entrypoint.sh` strips Windows CRLF (`tr -d '\r'`) before `gpg --batch --import`

4. Git is configured with `commit.gpgsign=true` and the key ID

5. For passphrase-protected keys, `gpg-agent` with `--pinentry-mode loopback`
   and `--passphrase-file` can be configured. For simplicity, v1 recommends
   using a key without passphrase inside the container (the key file itself
   is the secret boundary).

Known gotcha: if the exported `.asc` file was opened/saved in a Windows text editor,
it may have BOM bytes or CRLF corruption. The `tr -d '\r'` handles CRLF.
If import still fails, check for BOM: `sed -i '1s/^\xEF\xBB\xBF//' "$KEY_FILE"`.

## 15) State management

All durable state lives in GitHub (issues, labels, PRs). Local state is operational
convenience — the system must recover if state files are lost.

### State files (in /workspace/state/)

| File | Purpose | Recovery if lost |
|------|---------|-----------------|
| `executor/<id>/active_task` | Currently claimed task ID | Re-query `gh issue list -l "claimed-by:<id>"` |
| `executor/<id>/session_<n>` | Claude session ID for resume | Starts fresh session (loses context, not data) |
| `planner.log` | Planner output log | Informational only |
| `executor/<id>/run_<n>.log` | Executor run logs | Informational only |

### Recovery after restart

1. Executor starts, finds no `active_task` file
2. Queries GitHub for issues labeled `in-progress + claimed-by:<EXECUTOR_ID>`
3. If found: writes task ID to state file, resumes work
4. If not found: proceeds to claim new task

This means the executor loop's first action should check GitHub for existing claims,
not just the local state file. The state file is a fast-path optimization.

## 16) Implementation order

### Step 1: Dockerfile + entrypoint
Build the image, verify Claude Code runs in `-p` mode, verify `gh` auth works,
verify GPG import works. This is the foundation — nothing else works without it.

**Acceptance: `docker run ... claude -p "echo hello" --dangerously-skip-permissions` works.**

### Step 2: lib.sh + planner-loop.sh
Implement `sync_repo` and the planner outer loop. Start with a minimal planner prompt.
Test against a real repo with a feature issue.

**Acceptance: Planner creates a plan issue from a feature request.**

### Step 3: Planner prompt refinement
Iterate on `prompts/planner.md` until plans are useful and tasks are well-scoped.
This is prompt engineering, not code — test by running the planner repeatedly.

**Acceptance: Plan → tasks flow works end-to-end. No duplicates on re-runs.**

### Step 4: executor-loop.sh
Implement the executor loop: claim, worktree, Claude invocation, PR monitoring.
Start with a simple task (e.g., "add a comment to file X").

**Acceptance: Executor claims a task, creates a branch, commits, opens a PR.**

### Step 5: Executor prompt refinement
Iterate on `prompts/executor-implement.md` until code quality is acceptable.
Test with progressively harder tasks.

**Acceptance: Executor produces mergeable PRs for real tasks.**

### Step 6: docker-compose.yml + end-to-end
Wire up both services with shared volumes. Run the full flow:
feature issue → plan → tasks → implementation → PR → merge.

**Acceptance: Human creates a feature issue, walks away, comes back to merged PRs.**

### Step 7: Hardening
- Add label auto-creation
- Add recovery-from-restart logic
- Add logging/observability
- Test GPG signing end-to-end with Windows-exported keys

## 17) What this plan does NOT include (and why)

| Omitted | Reason |
|---------|--------|
| Python codebase | Bash + Claude + gh is sufficient. No custom adapters needed. |
| Custom GitHub client | `gh` CLI does everything we need. |
| Custom git client | `git` CLI does everything we need. |
| Contract tests | The prompts are the contract. Test by running the system. |
| 6 milestones | 7 steps, each testable independently. |
| Multi-executor support | v1 is single executor. Label-based claiming works for one. |
| Webhook/event queue | Polling is the explicit design choice. |
| Playwright/browsers | Not needed — agents work with code and CLI tools only. |
| Custom idempotency engine | Prompts instruct Claude to search before creating. `gh` queries are the idempotency check. |
