# Dockerized Planner/Executor — Revised Plan (v2)

Date: 2026-02-23

## 1) Philosophy

Claude Code already knows how to use `gh`, `git`, read code, write code, and reason about
GitHub issues. We don't need to reimplement those capabilities in custom adapters.

This plan builds a **TypeScript orchestration layer** that handles the deterministic work
(loops, timing, task claiming, worktree management, PR monitoring) and delegates all
reasoning to Claude Code invoked in `-p` (print/headless) mode with role-specific prompts.

A **minimal bash entrypoint** handles OS-level plumbing that is genuinely better in shell:
credential import, key permissions, git identity, and `gh` auth. Everything else is TypeScript.

The complexity lives in the **prompts**, not the code.

Why TypeScript over bash: Node.js is already required for Claude Code CLI. Since the
runtime dependency exists regardless, TypeScript gives us type safety, proper error handling,
async/await for concurrent operations, and testability — without adding any new dependencies.

## 2) Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  Docker image  (one image, two entrypoint commands)         │
│                                                             │
│  Installed: node, claude code, git, gh, gpg, openssh        │
│                                                             │
│  entrypoint.sh  (bash — OS plumbing only)                   │
│    ├── read GH_TOKEN from env                               │
│    ├── configure git identity + HTTPS auth                  │
│    ├── import signing keys (off/gpg/ssh)                    │
│    ├── authenticate gh CLI                                  │
│    ├── validate Claude credentials file                     │
│    └── exec node dist/index.js <planner|executor>           │
│                                                             │
│  TypeScript orchestration (compiled to dist/)               │
│                                                             │
│  planner.ts                   executor.ts                   │
│    while true:                  while true:                 │
│      syncRepo()                   syncRepo()                │
│      Phase 1: plan.md prompt      Phase 0: recover state    │
│      Phase 2: tasks.md prompt     Phase 1: claimTask()      │
│      sleep()                      Phase 2: ensureWorktree() │
│                                   Phase 3: exec.md prompt   │
│                                   Phase 4: PR monitoring    │
│                                   Phase 5: review.md prompt │
│                                   sleep()                   │
│                                                             │
│  Claude does the thinking:                                  │
│    reads issues, writes plans, writes code,                 │
│    creates PRs, commits, pushes                             │
└─────────────────────────────────────────────────────────────┘
```

## 3) Responsibility split

### Bash handles (OS plumbing — `entrypoint.sh` only)

- Git identity (`git config --global`)
- HTTPS token-based git auth
- GPG key import (copy from mount → container-owned path → `gpg --import`)
- SSH key setup (copy from mount → container-owned path → `chmod 600`)
- `gh auth login --with-token`
- Claude credentials file validation

### TypeScript handles (deterministic orchestration)

- Polling loops and sleep intervals
- Repo sync (`git fetch`, `git reset` via `execa`)
- Task claiming with nonce-based lease pattern
- Label transitions (`gh issue edit` via `execa`)
- Worktree creation/reuse (`git worktree add` via `execa`)
- Claude CLI invocation and output parsing
- PR status polling and merge decisions
- CI failure review loop
- State files (active task ID, session ID)
- Cost controls (max turns, rate limits)
- Structured logging
- Env var parsing and validation
- Graceful shutdown (SIGTERM handler)

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
package.json
tsconfig.json
src/
  index.ts              # parse role arg, launch planner or executor loop
  planner.ts            # planner polling loop (two-phase: plan + tasks)
  executor.ts           # executor polling loop (claim → implement → review → merge)
  claude.ts             # claude -p CLI invocation wrapper
  github.ts             # gh CLI wrapper (issues, PRs, labels, comments)
  git.ts                # git CLI wrapper (sync, worktree, commit, push)
  signing.ts            # signing validation (entrypoint does the actual import)
  state.ts              # local state file management + GitHub recovery
  config.ts             # env var parsing + validation + defaults
  types.ts              # shared type definitions
  logger.ts             # structured logging with timestamps
scripts/
  entrypoint.sh         # credential setup only, then exec node
prompts/
  plan.md               # planner: create/update plan issues from features
  tasks.md              # planner: decompose approved plans into task issues
  exec.md               # executor: implement code changes
  review.md             # executor: diagnose CI failures and propose fixes
secrets/                # gitignored, mounted at runtime
  gpg_private_key.asc   # optional, armored GPG key export
  ssh_signing_key       # optional, SSH private key
  ssh_signing_key.pub   # optional, SSH public key
```

## 5) Dockerfile

Multi-stage build: compile TypeScript in the `build` stage, copy only compiled JS and
production dependencies to the `runtime` stage.

```dockerfile
FROM node:20-slim AS base

ARG CLAUDE_CODE_VERSION=latest

RUN apt-get update && apt-get install -y --no-install-recommends \
    git gh gpg gpg-agent jq curl ca-certificates openssh-client \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

RUN useradd -m -s /bin/bash agent
RUN mkdir -p /workspace/repo /workspace/worktrees /workspace/state \
    && chown -R agent:agent /workspace

# --- Build stage: compile TypeScript ---
FROM base AS build

WORKDIR /opt/agent
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npx tsc

# --- Runtime stage ---
FROM base AS runtime

WORKDIR /opt/agent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /opt/agent/dist/ ./dist/
COPY --chmod=755 scripts/entrypoint.sh /opt/agent/scripts/entrypoint.sh
COPY prompts/ /opt/agent/prompts/

RUN chown -R agent:agent /opt/agent

USER agent
WORKDIR /workspace

ENV DISABLE_AUTOUPDATER=1
ENV DISABLE_NONESSENTIAL_TRAFFIC=1

ENTRYPOINT ["/opt/agent/scripts/entrypoint.sh"]
```

Key choices:
- `node:20-slim` — smaller image; Node is required for Claude Code CLI anyway
- Multi-stage — `build` stage has full devDependencies (TypeScript compiler); `runtime` has only production deps
- Layer caching — `package.json`/`package-lock.json` copied before source so `npm ci` is cached unless deps change
- Non-root `agent` user for security
- `/workspace/` as the working root, matching the volume contract
- Auto-updater disabled for deterministic container builds

### Build-time secrets policy

**No secrets are baked into the image.** If the build ever requires private access
(e.g., private npm registries, private git dependencies), use Docker BuildKit secrets:

```dockerfile
# syntax=docker/dockerfile:1
RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN=$(cat /run/secrets/npm_token) npm ci
```

Build with: `docker build --secret id=npm_token,env=NPM_TOKEN .`

BuildKit secrets are never written to image layers. This is a normative requirement:
any future build-time credential must use `--mount=type=secret`, never `ARG` or `ENV`.

## 6) docker-compose.yml

```yaml
services:
  planner:
    build: .
    command: ["planner"]
    restart: unless-stopped
    environment:
      REPO_URL: ${REPO_URL}
      REPO_SLUG: ${REPO_SLUG}
      BASE_BRANCH: ${BASE_BRANCH:-main}
      GIT_AUTHOR_NAME: ${GIT_AUTHOR_NAME}
      GIT_AUTHOR_EMAIL: ${GIT_AUTHOR_EMAIL}
      PLANNER_POLL_INTERVAL_SECONDS: ${PLANNER_POLL_INTERVAL_SECONDS:-120}
      MAX_TURNS_PER_RUN: ${PLANNER_MAX_TURNS:-50}
      GIT_COMMIT_SIGNING: ${GIT_COMMIT_SIGNING:-off}
      GIT_SIGNING_KEY: ${GIT_SIGNING_KEY:-}
      SIGNING_KEYS_MOUNT: /mnt/host-keys
    secrets:
      - GH_TOKEN
    volumes:
      - repo_data:/workspace/repo
      - state_data:/workspace/state
      - ${CLAUDE_CREDENTIALS_FILE}:/home/agent/.claude/.credentials.json:ro
      - ${SIGNING_KEYS_PATH:-./secrets}:/mnt/host-keys:ro

  executor:
    build: .
    command: ["executor"]
    restart: unless-stopped
    environment:
      REPO_URL: ${REPO_URL}
      REPO_SLUG: ${REPO_SLUG}
      BASE_BRANCH: ${BASE_BRANCH:-main}
      GIT_AUTHOR_NAME: ${GIT_AUTHOR_NAME}
      GIT_AUTHOR_EMAIL: ${GIT_AUTHOR_EMAIL}
      EXECUTOR_ID: ${EXECUTOR_ID:-executor-01}
      EXECUTOR_POLL_INTERVAL_SECONDS: ${EXECUTOR_POLL_INTERVAL_SECONDS:-60}
      MAX_TURNS_PER_RUN: ${EXECUTOR_MAX_TURNS:-100}
      VALIDATION_COMMAND: ${VALIDATION_COMMAND:-}
      GIT_COMMIT_SIGNING: ${GIT_COMMIT_SIGNING:-off}
      GIT_SIGNING_KEY: ${GIT_SIGNING_KEY:-}
      SIGNING_KEYS_MOUNT: /mnt/host-keys
    secrets:
      - GH_TOKEN
    volumes:
      - repo_data:/workspace/repo
      - worktrees_data:/workspace/worktrees
      - state_data:/workspace/state
      - ${CLAUDE_CREDENTIALS_FILE}:/home/agent/.claude/.credentials.json:ro
      - ${SIGNING_KEYS_PATH:-./secrets}:/mnt/host-keys:ro

volumes:
  repo_data:
  worktrees_data:
  state_data:

secrets:
  GH_TOKEN:
    environment: GH_TOKEN
```

Key choices:
- `GH_TOKEN` as a Docker Compose secret sourced from environment — tokens are sensitive and must never be passed as plain environment variables (visible in `docker inspect`, process listings, logs)
- Claude auth via mounted `.credentials.json` file (read-only)
- Signing keys mounted read-only at `/mnt/host-keys`, copied to container-owned paths by entrypoint
- Shared `repo_data` volume — planner only reads; executor uses separate worktrees volume

## 7) entrypoint.sh

Runs before Node.js starts. Handles OS-level credential setup only.

```bash
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
# 4. Authenticate gh CLI
# =========================================================
echo "$GH_TOKEN" | gh auth login --with-token

# =========================================================
# 5. Validate Claude credentials
# =========================================================
CLAUDE_CREDS="/home/agent/.claude/.credentials.json"
if [ ! -f "$CLAUDE_CREDS" ]; then
  echo "FATAL: Claude credentials file not found at ${CLAUDE_CREDS}"
  echo "Mount your credentials file via: -v /path/to/.credentials.json:${CLAUDE_CREDS}:ro"
  exit 1
fi

# =========================================================
# 6. Hand off to TypeScript
# =========================================================
exec node /opt/agent/dist/index.js "$ROLE"
```

Key differences from v1:
- Tri-state signing (`off|gpg|ssh`) instead of boolean
- Keys **copied** from mount to container-owned paths — fixes Windows permission issues
- Strips both CRLF and BOM from GPG keys
- Validates Claude credentials file before starting
- Final `exec` runs Node.js, not bash loop scripts

## 8) TypeScript modules

### package.json

```json
{
  "name": "github-driven-claude-agent",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "tsc",
    "start:planner": "node dist/index.js planner",
    "start:executor": "node dist/index.js executor",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "execa": "^9.5.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "typescript": "^5.4.0"
  }
}
```

Single runtime dependency: `execa`. All other tools (`git`, `gh`, `claude`) are CLI
subprocesses invoked via `execa`.

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

### src/types.ts — shared type definitions

```typescript
export type Role = 'planner' | 'executor';
export type SigningMode = 'off' | 'gpg' | 'ssh';

export interface Config {
  role: Role;
  repoUrl: string;
  repoSlug: string;           // "org/repo"
  baseBranch: string;          // default "main"
  ghToken: string;
  pollIntervalSeconds: number; // role-specific default
  executorId: string;          // only meaningful for executor
  maxTurnsPerRun: number;
  gitCommitSigning: SigningMode;
  gitSigningKey: string;
  signingKeysMount: string;
  validationCommand: string;   // optional, executor only
  gitAuthorName: string;
  gitAuthorEmail: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'OPEN' | 'CLOSED';
}

export interface GitHubPR {
  number: number;
  title: string;
  headBranch: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  reviewDecision: string | null;
  checksStatus: ChecksStatus;
}

export type ChecksStatus = 'passing' | 'failing' | 'pending';
export type PRStatus = 'mergeable' | 'failing' | 'pending' | 'conflicting';

export interface AgentMeta {
  entity: 'plan' | 'task';
  source_feature: number;
  source_plan?: number;
  executor_id?: string;
  branch?: string;
  pr?: number;
}

export interface ClaudeInvocation {
  prompt: string;
  systemPromptFile?: string;
  maxTurns: number;
  outputFormat: 'text' | 'json';
  workingDirectory: string;
  resumeSessionId?: string;
}

export interface ClaudeResult {
  success: boolean;
  sessionId?: string;
  result?: string;
  durationMs: number;
}

export interface ExecutorState {
  activeTaskId: number | null;
  sessionId: string | null;
}

export interface ClaimAttempt {
  taskId: number;
  nonce: string;
  success: boolean;
}
```

### src/config.ts — env var parsing

Loads all environment variables, applies defaults, validates required values.
Fails fast with clear error messages.

```typescript
export function loadConfig(): Config;
```

Required env vars: `REPO_URL`, `REPO_SLUG`, `GH_TOKEN` (or `GITHUB_TOKEN`),
`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`.

Defaults: `BASE_BRANCH=main`, `PLANNER_POLL_INTERVAL_SECONDS=120`,
`EXECUTOR_POLL_INTERVAL_SECONDS=60`, `EXECUTOR_ID=executor-01`,
`MAX_TURNS_PER_RUN=50` (planner) / `100` (executor),
`GIT_COMMIT_SIGNING=off`, `SIGNING_KEYS_MOUNT=/mnt/host-keys`.

### src/logger.ts — structured logging

```typescript
export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export function createLogger(role: Role, executorId?: string): Logger;
```

Output: `[2026-02-23T10:00:00.000Z] [planner] INFO: message {context}`.
Writes to stdout. No external logging library in v1.

### src/git.ts — git CLI wrapper

```typescript
/** Clone if missing, then fetch + checkout + reset to origin/BASE_BRANCH */
export async function syncRepo(config: Config): Promise<void>;

/** Ensure worktree exists for task. Returns worktree path. */
export async function ensureWorktree(
  config: Config, taskId: number, branch: string,
): Promise<string>;

/** Push current branch in worktree to origin */
export async function pushBranch(worktreePath: string): Promise<void>;

/** Generate branch name: task/<id>-<slugified-title> */
export function makeBranchName(taskId: number, title: string): string;
```

All calls use `execa('git', [...args], { cwd })`.

### src/github.ts — gh CLI wrapper

```typescript
/** List issues matching labels */
export async function listIssues(config: Config, labels: string[]): Promise<GitHubIssue[]>;

/** Create an issue, returns issue number */
export async function createIssue(
  config: Config, title: string, body: string, labels: string[],
): Promise<number>;

/** Add/remove labels on an issue */
export async function editIssueLabels(
  config: Config, issueNumber: number, add: string[], remove: string[],
): Promise<void>;

/** Ensure all workflow labels exist (idempotent) */
export async function ensureLabels(config: Config): Promise<void>;

/** Find PR by head branch */
export async function findPRByBranch(config: Config, branch: string): Promise<GitHubPR | null>;

/** Get PR status: mergeable / failing / pending / conflicting */
export async function getPRStatus(config: Config, prNumber: number): Promise<PRStatus>;

/** Get CI failure details for review prompt */
export async function getPRCheckDetails(config: Config, prNumber: number): Promise<string>;

/** Squash-merge a PR */
export async function mergePR(config: Config, prNumber: number): Promise<void>;

/** Nonce-based task claiming: label swap + bot comment + re-read + verify */
export async function claimTask(config: Config, taskId: number): Promise<ClaimAttempt>;

/** Post machine-readable comment recording branch/worktree/PR mapping */
export async function postWorkMapping(
  config: Config, taskId: number, branch: string, worktreePath: string, prNumber?: number,
): Promise<void>;
```

#### Claim protocol (nonce-based lease)

1. Generate a UUID nonce
2. Add labels `in-progress` + `claimed-by:<EXECUTOR_ID>`, remove `todo`
3. Post comment: `<!-- claim-nonce:<nonce> executor:<EXECUTOR_ID> -->`
4. Wait 1 second (allow GitHub to propagate)
5. Re-read issue labels and comments
6. If another executor's `claimed-by:` label or newer claim-nonce exists, we're the loser — unclaim and return `{ success: false }`

### src/claude.ts — Claude Code CLI wrapper

```typescript
/**
 * Invoke Claude Code CLI in headless (-p) mode.
 *
 * Uses --append-system-prompt-file (not --system-prompt-file) to preserve
 * Claude Code's built-in tool instructions (Bash, Read, Edit, etc.).
 *
 * Design: We call the CLI rather than the TypeScript SDK because the CLI
 * provides the full Claude Code agent loop (tool use, file editing, bash
 * execution) out of the box.
 */
export async function invokeClaude(invocation: ClaudeInvocation): Promise<ClaudeResult>;
```

Implementation builds CLI args from the `ClaudeInvocation` object:

```typescript
const args = [
  '-p', invocation.prompt,
  '--dangerously-skip-permissions',
  '--max-turns', String(invocation.maxTurns),
  '--output-format', invocation.outputFormat,
  '--verbose',
];
if (invocation.systemPromptFile) {
  args.push('--append-system-prompt-file', invocation.systemPromptFile);
}
if (invocation.resumeSessionId) {
  args.push('--resume', invocation.resumeSessionId);
}
```

Timeout: 30 minutes per invocation (separate from `--max-turns`).
On JSON output, parses `session_id` from response for resume support.

### src/state.ts — local state management

```typescript
/** Read executor state from local file. Returns null if missing. */
export function readExecutorState(executorId: string): ExecutorState | null;

/** Write executor state to local file */
export function writeExecutorState(executorId: string, state: ExecutorState): void;

/** Clear active task from state */
export function clearActiveTask(executorId: string): void;

/** Recover active task from GitHub (query claimed-by:<id> issues) */
export async function recoverStateFromGitHub(config: Config): Promise<ExecutorState>;
```

State file: `/workspace/state/executor/<executorId>/state.json`.
GitHub is the source of truth. The local file is a fast-path optimization.

### src/signing.ts — signing validation

```typescript
/** Validate that signing was properly set up by entrypoint.sh.
 *  Checks GPG key availability or SSH key file existence.
 *  Throws on failure when signing is enabled. */
export async function validateSigningSetup(config: Config): Promise<void>;
```

Does NOT do the actual import — that's `entrypoint.sh`'s job.

## 9) Planner loop

`src/planner.ts` — two-phase invocation per cycle.

```typescript
export async function runPlannerLoop(config: Config, logger: Logger): Promise<never>;
```

### Algorithm

```
loop forever:
  try:
    syncRepo(config)

    // Phase 1: Plan creation
    features = listIssues(config, ['feature', 'needs-plan'])
    if features.length > 0:
      prompt = buildPlannerPrompt(config, features)
      invokeClaude({
        prompt,
        systemPromptFile: '/opt/agent/prompts/plan.md',
        maxTurns: config.maxTurnsPerRun,
        outputFormat: 'text',
        workingDirectory: '/workspace/repo',
      })

    // Phase 2: Task decomposition
    readyPlans = listIssues(config, ['plan:ready'])
    plansNeedingTasks = readyPlans.filter(p => !p.labels.includes('plan:tasks-created'))
    if plansNeedingTasks.length > 0:
      prompt = buildTaskDecompPrompt(config, plansNeedingTasks)
      invokeClaude({
        prompt,
        systemPromptFile: '/opt/agent/prompts/tasks.md',
        maxTurns: config.maxTurnsPerRun,
        outputFormat: 'text',
        workingDirectory: '/workspace/repo',
      })

    // Phase 3: Plan completion
    plansWithTasks = listIssues(config, ['plan:tasks-created'])
    if plansWithTasks.length > 0:
      openTasks = listIssues(config, ['task'])
      for plan in plansWithTasks:
        remaining = openTasks.filter(t => parseAgentMeta(t.body)?.source_plan === plan.number)
        if remaining.length === 0:
          editIssueLabels(config, plan.number, ['plan:done'], ['plan:tasks-created'])
          closeIssue(config, plan.number)
          // Close source feature
          meta = parseAgentMeta(plan.body)
          if meta?.source_feature:
            editIssueLabels(config, meta.source_feature, ['done'], ['planned'])
            closeIssue(config, meta.source_feature)

  catch error:
    logger.error('Planner iteration failed', { error })

  sleep(config.pollIntervalSeconds * 1000)
```

### Prompt builders

```typescript
function buildPlannerPrompt(config: Config, features: GitHubIssue[]): string {
  const featureList = features
    .map(f => `- #${f.number}: ${f.title}`)
    .join('\n');
  return `You are the Planner agent for repository ${config.repoSlug}.
Working directory: /workspace/repo (synced to ${config.baseBranch})

The following feature issues need plans:
${featureList}

Process each feature. Use \`gh\` for all GitHub API operations.
Repository: ${config.repoSlug}`;
}

function buildTaskDecompPrompt(config: Config, plans: GitHubIssue[]): string {
  const planList = plans
    .map(p => `- #${p.number}: ${p.title}`)
    .join('\n');
  return `You are the Planner agent for repository ${config.repoSlug}.
Working directory: /workspace/repo (synced to ${config.baseBranch})

The following approved plans need task decomposition:
${planList}

Create task issues for each plan. Use \`gh\` for all GitHub API operations.
Repository: ${config.repoSlug}`;
}
```

## 10) Executor loop

`src/executor.ts` — manages the full task lifecycle.

```typescript
export async function runExecutorLoop(config: Config, logger: Logger): Promise<never>;
```

### Algorithm

```
loop forever:
  try:
    syncRepo(config)

    // --- Phase 0: Recovery / Resume ---
    state = readExecutorState(config.executorId)
    if state is null:
      state = recoverStateFromGitHub(config)
      if state.activeTaskId:
        writeExecutorState(config.executorId, state)
        logger.info('Recovered active task from GitHub', { taskId: state.activeTaskId })

    // --- Phase 1: Claim if idle ---
    if state.activeTaskId is null:
      tasks = listIssues(config, ['task', 'todo'])
      if tasks.length === 0:
        logger.info('No tasks available. Sleeping.')
        sleep; continue

      claim = claimTask(config, tasks[0].number)
      if !claim.success:
        logger.warn('Claim failed, another executor won')
        sleep; continue

      state = { activeTaskId: claim.taskId, sessionId: null }
      writeExecutorState(config.executorId, state)

    // --- Phase 2: Setup worktree ---
    task = getIssue(config, state.activeTaskId)
    branch = makeBranchName(state.activeTaskId, task.title)
    worktreePath = ensureWorktree(config, state.activeTaskId, branch)
    postWorkMapping(config, state.activeTaskId, branch, worktreePath)

    // --- Phase 3: Implementation ---
    prompt = buildExecutorPrompt(config, task, branch, worktreePath)
    result = invokeClaude({
      prompt,
      systemPromptFile: '/opt/agent/prompts/exec.md',
      maxTurns: config.maxTurnsPerRun,
      outputFormat: 'json',
      workingDirectory: worktreePath,
      resumeSessionId: state.sessionId,
    })
    if result.sessionId:
      state.sessionId = result.sessionId
      writeExecutorState(config.executorId, state)

    // --- Phase 4: PR monitoring ---
    pr = findPRByBranch(config, branch)
    if pr is null:
      logger.info('No PR yet, will continue next iteration')
      sleep; continue

    postWorkMapping(config, state.activeTaskId, branch, worktreePath, pr.number)
    prStatus = getPRStatus(config, pr.number)

    switch prStatus:
      case 'mergeable':
        mergePR(config, pr.number)
        editIssueLabels(config, state.activeTaskId, ['done'], ['in-progress', `claimed-by:${config.executorId}`])
        closeIssue(config, state.activeTaskId)
        clearActiveTask(config.executorId)
        state = { activeTaskId: null, sessionId: null }

      case 'failing':
        // --- Phase 5: Review loop ---
        runReviewLoop(config, logger, state, task, pr, worktreePath)

      case 'pending':
        logger.info('Checks pending, will re-check next iteration')

      case 'conflicting':
        logger.warn('Merge conflicts detected')

  catch error:
    logger.error('Executor iteration failed', { error })

  sleep(config.pollIntervalSeconds * 1000)
```

### Review loop (CI failure recovery)

When CI fails, a dedicated review phase invokes Claude with `prompts/review.md`:

```typescript
async function runReviewLoop(
  config: Config, logger: Logger, state: ExecutorState,
  task: GitHubIssue, pr: GitHubPR, worktreePath: string,
): Promise<void> {
  const MAX_REVIEW_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_REVIEW_ATTEMPTS; attempt++) {
    const checkDetails = await getPRCheckDetails(config, pr.number);
    const prompt = buildReviewPrompt(config, task, pr, checkDetails);

    await invokeClaude({
      prompt,
      systemPromptFile: '/opt/agent/prompts/review.md',
      maxTurns: config.maxTurnsPerRun,
      outputFormat: 'text',
      workingDirectory: worktreePath,
    });

    await pushBranch(worktreePath);

    // Poll for CI completion (up to 10 minutes)
    const newStatus = await pollForCIResult(config, pr.number, 10 * 60 * 1000);

    if (newStatus === 'mergeable') return;
    if (newStatus === 'failing') continue;
  }

  // Exhausted attempts — mark as blocked
  await addComment(config, task.number,
    `CI failures could not be resolved after ${MAX_REVIEW_ATTEMPTS} review attempts. Marking as blocked.`
  );
  await editIssueLabels(config, task.number, ['blocked'], ['in-progress']);
}
```

### Prompt builders

```typescript
function buildExecutorPrompt(
  config: Config, task: GitHubIssue, branch: string, worktreePath: string,
): string {
  const validation = config.validationCommand
    ? `Validation command: ${config.validationCommand}`
    : 'No validation command configured.';
  return `You are the Executor agent for repository ${config.repoSlug}.
Working directory: ${worktreePath} (branch: ${branch})
Task issue: #${task.number} — ${task.title}

Task description:
${task.body}

${validation}

Implement the changes described in this task.`;
}

function buildReviewPrompt(
  config: Config, task: GitHubIssue, pr: GitHubPR, checkDetails: string,
): string {
  return `You are the Executor agent reviewing CI failures for repository ${config.repoSlug}.
Task: #${task.number} — ${task.title}
PR: #${pr.number}

The following CI checks have failed:
${checkDetails}

Diagnose the failures and fix the code.`;
}
```

## 11) Prompts (the actual brain)

These are the most important files in the project. They tell Claude what to do.

### prompts/plan.md

```markdown
# Planner Agent Instructions — Plan Creation

You are the planning agent. Your job is to turn feature requests into actionable plans.

## For each feature issue (labeled "feature" + "needs-plan"):

### Step 1 — Search for existing plan
Search for an issue with metadata `source_feature: <feature_number>`.
If found, update it instead of creating a new one.

### Step 2 — Create or update the plan issue
- Title: "Plan: <feature title>"
- Labels: `plan:draft`
- Body must include:
  - Summary of the feature
  - Analysis of affected files/components (read the codebase!)
  - Ordered checklist of implementation tasks
  - Metadata block (see format below)

### Step 3 — Assess plan readiness
- If you need human input, add label `plan:needs-clarification`
  and comment explaining what you need. Stop.
- If the plan is clear and complete, add label `plan:ready`.

## Metadata block format
Embed this HTML comment in every issue you create:
<!-- agent-meta
entity: plan
source_feature: <feature_issue_number>
-->

## Rules
- NEVER create duplicate plans. Always search first.
- Use `gh issue list`, `gh issue create`, `gh issue edit`, `gh issue view`.
- Read the codebase to make informed plans.
- Keep plans concrete — reference specific files and functions.
```

### prompts/tasks.md

```markdown
# Planner Agent Instructions — Task Decomposition

You are the planning agent. Your job is to decompose approved plans into task issues.

## For each plan issue (labeled "plan:ready" but NOT "plan:tasks-created"):

### Step 1 — Read the plan
Read the plan issue body. Understand each checklist item.

### Step 2 — Create task issues
For each checklist item:
- Create an issue titled "Task: <description>"
- Labels: `task`, `todo`
- Body: detailed requirements, relevant file paths, acceptance criteria
- Include metadata block linking to plan and feature

### Step 3 — Update plan issue
- Update checklist items with links to created task issues
- Add label `plan:tasks-created`
- On the source feature issue: remove `needs-plan`, add `planned`

## Metadata block format
<!-- agent-meta
entity: task
source_feature: <feature_issue_number>
source_plan: <plan_issue_number>
-->

## Rules
- NEVER create duplicate tasks. Search by metadata first, title second.
- Each task should be independently implementable.
- Tasks should be ordered by dependency (independent tasks first).
```

### prompts/exec.md

```markdown
# Executor Agent Instructions

You are the executor agent. You implement code changes for a single task.

## Your environment
- You are in a git worktree checked out to a feature branch
- The branch is based on the latest base branch
- You have full access to the codebase

## Your job
1. Read and understand the task requirements (provided in the prompt)
2. Read relevant source files to understand existing code
3. Implement the required changes
4. Run validation if a command is specified in the prompt
5. If validation fails, fix the issues and retry (up to 3 attempts)
6. Stage and commit your changes with conventional commit messages
7. Push the branch: `git push -u origin HEAD`
8. Create a PR (or update existing) using `gh pr create`:
   - Title: concise description of the change
   - Body: what changed, why, link to task issue (#<number>)
   - Add label `task:<task_id>`

## Rules
- Make focused, minimal changes. Do not refactor unrelated code.
- Match existing code style and conventions.
- Use conventional commits (feat:, fix:, refactor:, etc.)
- If stuck or task is unclear, comment on the issue and stop.
- Do NOT merge the PR. The orchestrator handles merging.
- Do NOT modify workflow labels. The orchestrator handles label transitions.
```

### prompts/review.md

```markdown
# Review Agent Instructions

You are reviewing CI failures for a pull request.

## Your environment
- You are in the worktree for the task branch
- CI checks have failed on the PR
- Failure details are provided in the prompt

## Your job
1. Read and understand the CI failure output
2. Identify the root cause in the code
3. Fix the failing code
4. Run the validation command locally if available
5. Stage and commit the fix: `fix: address CI failure — <description>`
6. Do NOT push — the orchestrator will push for you

## Rules
- Focus only on fixing what CI flagged. Do not add features.
- If the failure is in test infrastructure (not your code), comment on the PR and stop.
- If you cannot determine the cause, comment on the PR explaining what you tried.
```

## 12) Label protocol

| Label | Applied by | Meaning |
|-------|-----------|---------|
| `feature` | Human | This issue is a feature request |
| `needs-plan` | Human | Feature needs a plan |
| `planned` | Planner | Plan and tasks created |
| `in-execution` | Executor (TS) | Feature has at least one task in progress (optional) |
| `done` | Planner | Feature complete — all plans done (replaces `planned`) |
| `plan:draft` | Planner | Plan exists, not yet approved |
| `plan:needs-clarification` | Planner | Human input needed |
| `plan:ready` | Human/Planner | Plan approved, tasks can be created |
| `plan:tasks-created` | Planner | All task issues created |
| `plan:done` | Planner | All tasks complete — plan closed |
| `task` | Planner | This issue is an implementation task |
| `todo` | Planner | Task available for claiming |
| `in-progress` | Executor (TS) | Task claimed and being worked on |
| `claimed-by:<id>` | Executor (TS) | Which executor owns this task |
| `done` | Executor (TS) | Task complete, PR merged |
| `blocked` | Executor (TS) | Task needs human intervention |
| `needs-human` | Planner/Executor | Requires human attention (broader than `blocked`) |

Labels are auto-created on first loop iteration via `gh label create --force`.

## 13) Cost and safety controls

### Per-invocation limits
- `--max-turns N`: caps how many tool calls Claude makes per run
  - Planner: 30 turns (enough to process several features)
  - Executor: 50 turns (implementation may need many file edits)
- Configurable via `MAX_TURNS_PER_RUN` env var
- 30-minute timeout per Claude invocation (hard kill)

### Rate limiting
- Planner sleeps 2 minutes between runs by default
- Executor sleeps 1 minute between runs by default
- When no work is available, both skip the Claude invocation entirely (free)

### Guardrails in prompts
- Planner prompt: "NEVER create duplicates. Always search first."
- Executor prompt: "Make focused, minimal changes."
- Both: if stuck, comment and stop rather than looping

### Safety controls (v1)
- Review loop: max 3 attempts per CI failure, then mark `blocked`
- Circuit breaker: if the same task fails 3 consecutive iterations, mark `blocked`
- Graceful shutdown: SIGTERM handler finishes current operation before exiting

### Future additions (not v1)
- `--max-budget-usd` per invocation
- Hourly call counter / rate limiter

## 14) Commit signing (GPG / SSH)

Signing is controlled by `GIT_COMMIT_SIGNING` (default: `off`).

### Modes

| Mode | `GIT_COMMIT_SIGNING` | `GIT_SIGNING_KEY` | Key files in mount |
|------|---------------------|-------------------|--------------------|
| Off | `off` | not needed | none |
| GPG | `gpg` | key ID / fingerprint | `gpg_private_key.asc` |
| SSH | `ssh` | (auto-configured) | `ssh_signing_key` + `ssh_signing_key.pub` |

### Key handling (Windows-safe)

Signing keys are **mounted** from the host at `/mnt/host-keys` (read-only) and
**copied** into container-owned paths with proper permissions. Keys are never used
in-place from the mount — mounted volumes on Windows cannot represent Linux
permissions correctly.

The copy-then-chmod pattern in `entrypoint.sh`:

1. Mount keys read-only at `/mnt/host-keys`
2. Copy into `~/.gnupg/` (GPG) or `~/.ssh/` (SSH)
3. `chmod 700` directories, `chmod 600` private keys
4. Import (GPG) or configure git (SSH)

### GPG from Windows

1. Export: `gpg --armor --export-secret-keys <KEY_ID> > secrets/gpg_private_key.asc`
2. Entrypoint strips CRLF (`tr -d '\r'`) and BOM before import
3. For passphrase-protected keys: v1 recommends using a key without passphrase
   (the mounted file itself is the secret boundary)

### SSH signing

1. Export: copy your SSH key pair to `secrets/ssh_signing_key` + `secrets/ssh_signing_key.pub`
2. Entrypoint configures: `git config gpg.format ssh` + `user.signingkey` pointing to the public key
3. GitHub must have the corresponding public key registered for signature verification

## 15) State management

All durable state lives in GitHub (issues, labels, PRs). Local state is operational
convenience — the system must recover if state files are lost.

### State files (in /workspace/state/)

| File | Purpose | Recovery if lost |
|------|---------|-----------------|
| `executor/<id>/state.json` | Active task ID + Claude session ID | Re-query `gh issue list -l "claimed-by:<id>"` |
| `planner.log` | Planner output log | Informational only |
| `executor/<id>/run_<n>.log` | Executor run logs | Informational only |

### Recovery after restart

Implemented in `recoverStateFromGitHub()`:

1. Executor starts, checks local `state.json`
2. If missing or empty, queries GitHub for issues labeled `in-progress + claimed-by:<EXECUTOR_ID>`
3. If found: writes task ID to state file, resumes work
4. If not found: proceeds to claim new task

### Machine-readable comments

The executor posts structured comments on task issues to record operational state:

```html
<!-- work-mapping
executor: executor-01
branch: task/42-add-login
worktree: /workspace/worktrees/42
pr: 56
-->
```

This enables tracing task → branch → PR relationships from GitHub alone.

## 16) Implementation order

### Step 1: Project scaffold
`package.json`, `tsconfig.json`, `src/types.ts`, `src/config.ts`, `src/logger.ts`,
stub `src/index.ts` that loads config and logs it.

**Acceptance: `npx tsc` compiles. `node dist/index.js planner` logs parsed config.**

### Step 2: Git + GitHub wrappers
`src/git.ts`, `src/github.ts`. Test `syncRepo`, `ensureWorktree`, `listIssues`,
`ensureLabels`, `claimTask` against a real repo.

**Acceptance: wrapper functions work end-to-end against a test repository.**

### Step 3: Claude wrapper
`src/claude.ts`. Test with simple prompts.

**Acceptance: `invokeClaude({ prompt: 'say hello', ... })` returns a `ClaudeResult`.**

### Step 4: Entrypoint + Dockerfile
`scripts/entrypoint.sh`, `Dockerfile`. Verify build, credential setup, Node.js startup.

**Acceptance: `docker run ... planner` starts, logs "Agent starting", `gh auth status` succeeds.**

### Step 5: State + signing
`src/state.ts`, `src/signing.ts`.

**Acceptance: State round-trips correctly. Signing validation detects import status.**

### Step 6: Planner loop
`src/planner.ts`, `prompts/plan.md`, `prompts/tasks.md`.

**Acceptance: Feature issue → plan issue → task issues. No duplicates on re-runs.**

### Step 7: Executor loop
`src/executor.ts`, `prompts/exec.md`, `prompts/review.md`.

**Acceptance: Task → branch → commit → PR. CI failure → review → fix → merge.**

### Step 8: Docker Compose + end-to-end
`docker-compose.yml`, `.env.example`.

**Acceptance: `docker compose up` runs full flow. Human creates feature, walks away, comes back to merged PRs.**

### Step 9: Hardening
- Retry logic with exponential backoff for `gh` and `git` calls
- Circuit breaker for repeated task failures
- Graceful SIGTERM shutdown
- Recovery-from-restart tests
- GPG + SSH signing end-to-end with Windows-exported keys

## 17) What this plan does NOT include (and why)

| Omitted | Reason |
|---------|--------|
| Bash control plane | TypeScript provides type safety, better error handling, and testability. Bash only for OS plumbing in entrypoint. |
| Custom GitHub client | `gh` CLI does everything we need. |
| Custom git client | `git` CLI does everything we need. |
| Contract tests | The prompts are the contract. Test by running the system. |
| Multi-executor support | v1 is single executor. Nonce-based claiming is ready for multi-executor when needed. |
| Webhook/event queue | Polling is the explicit design choice. |
| Playwright/browsers | Not needed — agents work with code and CLI tools only. |
| Custom idempotency engine | Prompts instruct Claude to search before creating. `gh` queries are the idempotency check. |
| `ANTHROPIC_API_KEY` env var | Using mounted `.credentials.json` for Claude auth. |
