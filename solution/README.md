# GitHub-Driven Claude Agent

A Dockerized TypeScript orchestration layer that automates software development using either Claude Code CLI or Codex CLI. It monitors GitHub issues, creates implementation plans, decomposes them into tasks, writes code in isolated worktrees, opens PRs, and handles CI review loops — all autonomously.

## How it works

The system runs two polling loops inside Docker containers:

**Planner** reads GitHub issues labeled `feature` + `needs-plan`, invokes the selected provider CLI (`claude` or `codex`) to produce a plan issue, then decomposes approved plans into task issues.

**Executor** claims a `todo` task via a nonce-based lease protocol, checks out a git worktree, invokes the selected provider CLI to implement the changes, creates a PR, monitors CI, and runs a review loop (up to 3 attempts) if checks fail. On success it squash-merges the PR and closes the task.

```
Human creates feature issue
        |
        v
  +-----------+     Provider reads issue, analyzes codebase,
  |  Planner  | --> creates plan issue, decomposes into tasks
  +-----------+
        |
        v
  +-----------+     Provider claims task, writes code in worktree,
  |  Executor | --> creates PR, fixes CI failures, merges
  +-----------+
        |
        v
  Merged PR + closed issue
```

All reasoning happens inside the selected provider CLI (Claude via `claude -p` or Codex via `codex exec`). The TypeScript layer only handles deterministic work: polling, task claiming, worktree management, label transitions, PR monitoring, and state recovery.

## Prerequisites

- **Docker** and **Docker Compose**
- A **GitHub personal access token** with `repo` scope
- Provider authentication:
  - Claude mode: **Claude credentials file** (`~/.claude/.credentials.json`)
  - Codex mode: **Codex auth file** (`~/.codex/auth.json`)
- Outbound network access from containers (for RLM plugin bootstrap on startup)

## Quick start

```bash
cd solution

# 1. Copy and fill in your environment variables
cp .env.example .env
# Edit .env with your values (see Configuration below)

# 2. Build and run
docker compose up --build
```

The planner starts polling for feature issues every 2 minutes. The executor polls for tasks every 1 minute. Create a GitHub issue with labels `feature` and `needs-plan` on your target repo to kick things off.

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and set:

### Required

| Variable | Description |
|----------|-------------|
| `REPO_URL` | Full clone URL, e.g. `https://github.com/org/repo.git` |
| `REPO_SLUG` | GitHub `owner/repo` format |
| `GH_TOKEN` | GitHub personal access token with `repo` scope |
| `GIT_AUTHOR_NAME` | Git commit author name |
| `GIT_AUTHOR_EMAIL` | Git commit author email |
| `CLAUDE_CREDENTIALS_FILE` | Absolute path to your `~/.claude/.credentials.json` (required for Claude mode) |
| `CODEX_AUTH_FILE` | Absolute path to your `~/.codex/auth.json` file (required for Codex mode) |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_BRANCH` | `main` | Branch to sync against |
| `AGENT_PROVIDER` | `claude` | Shared provider selector: `claude` or `codex` |
| `PLANNER_PROVIDER` | _(empty)_ | Optional planner override for provider (`claude` or `codex`) |
| `EXECUTOR_PROVIDER` | _(empty)_ | Optional executor override for provider (`claude` or `codex`) |
| `PLANNER_POLL_INTERVAL_SECONDS` | `120` | Seconds between planner iterations |
| `PLANNER_MAX_TURNS` | `50` | Max planner tool-use turns hint passed to provider adapters |
| `PLANNER_MODEL` | _(empty)_ | Planner model override (`--model` where supported) |
| `CLAUDE_SUBAGENTS_ENABLED` | `false` | Enable custom Claude sub-agent definitions via `--agents` |
| `EXECUTOR_ID` | `executor-01` | Unique ID for this executor instance |
| `EXECUTOR_POLL_INTERVAL_SECONDS` | `60` | Seconds between executor iterations |
| `EXECUTOR_MAX_TURNS` | `100` | Max executor tool-use turns hint passed to provider adapters |
| `EXECUTOR_MODEL` | _(empty)_ | Executor model override (`--model` where supported) |
| `AGENT_MODEL` | _(empty)_ | Shared fallback model for both roles |
| `CLAUDE_MODEL` | _(empty)_ | Legacy fallback alias (used after `AGENT_MODEL`) |
| `VALIDATION_COMMAND` | _(empty)_ | Command for provider to run before committing (e.g. `npm test`) |
| `GIT_COMMIT_SIGNING` | `off` | Commit signing mode: `off`, `gpg`, or `ssh` |
| `GIT_SIGNING_KEY` | _(empty)_ | GPG key ID (required when `gpg` mode) |
| `SIGNING_KEYS_PATH` | `./secrets` | Host path to signing key files |
| `RLM_PLUGIN_ENABLED` | `true` | Enable RLM plugin bootstrap in container startup |
| `RLM_PLUGIN_REQUIRED` | `true` | Fail container startup if RLM setup fails |
| `RLM_PLUGIN_REF` | `rlm-claude-code@rlm-claude-code` | Plugin reference passed to `claude plugin install` |
| `RLM_PLUGIN_KEY` | `rlm-claude-code@rlm-claude-code` | Plugin key used in `~/.claude/settings.user.json` |
| `RLM_PLUGIN_NAME` | `rlm-claude-code` | Plugin short name used when checking installed plugins |
| `RLM_PLUGIN_SCOPE` | `user` | Claude plugin scope used during install |
| `RLM_MARKETPLACE_SOURCE` | `rand/rlm-claude-code` | Marketplace source used by `claude plugin marketplace add` |
| `RLM_PLUGIN_BUILD_HOOKS` | `true` | Build Go hook binaries (`session-init`, `complexity-check`, `trajectory-save`) when missing |
| `RLM_PLUGIN_SYNC_REQUIRED` | `true` | If `true`, fail startup when dependency sync is needed and `uv sync` fails |
| `RLM_PLUGIN_VERIFY_REQUIRED` | `true` | If `true`, fail startup when `rlm_core` import or hook health check fails |
| `RLM_ACTIVATION_MODE` | `complexity` | Initial activation mode written to RLM config on first bootstrap |
| `RLM_DEBUG` | `0` | Enable verbose RLM debug output (`1` to enable) |

Provider precedence is role-specific first, then shared fallback:
- Planner: `PLANNER_PROVIDER` -> `AGENT_PROVIDER` -> `claude`
- Executor: `EXECUTOR_PROVIDER` -> `AGENT_PROVIDER` -> `claude`

Model precedence is role-specific first, then shared fallbacks:
- Planner: `PLANNER_MODEL` -> `AGENT_MODEL` -> `CLAUDE_MODEL` -> provider default
- Executor: `EXECUTOR_MODEL` -> `AGENT_MODEL` -> `CLAUDE_MODEL` -> provider default

### Provider capability notes

| Capability | Claude | Codex |
|------------|--------|-------|
| System prompt file | Native `--append-system-prompt-file` | Emulated by prepending file content to prompt |
| Custom sub-agents | Native `--agents` | Not supported (ignored with warning) |
| Max-turn control | Native `--max-turns` | No direct CLI flag (orchestrator timeout and bounded loops still apply) |
| Session resume | `--resume <session_id>` | `codex exec resume <thread_id>` |

## RLM plugin integration

When provider is `claude`, the planner and executor bootstrap `rand/rlm-claude-code` during `entrypoint.sh` startup:

1. Ensures `uv` is available.
2. Installs `rlm-claude-code@rlm-claude-code` only when not already installed.
3. Builds Go hook binaries when missing (`RLM_PLUGIN_BUILD_HOOKS=true`), so hook-dispatch does not fall back to buggy Python scripts.
4. Creates plugin virtualenv when needed, then skips `uv sync` when `rlm_core` is already importable.
5. Runs `uv sync` only when required, then verifies `rlm_core` import.
6. Copies and runs `merge-plugin-hooks.py` to merge plugin hooks into `~/.claude/settings.json`.
7. Writes a default `~/.claude/rlm-config.json` (only when missing), using `RLM_ACTIVATION_MODE`.
8. Runs plugin `hook-dispatch.sh session-init` with JSON input as a startup health check.
9. Mirrors entrypoint output to `/workspace/logs/entrypoint-<role>.log` for startup debugging.

If `RLM_PLUGIN_REQUIRED=true`, startup fails fast when any RLM setup step fails.

When provider is `codex`, Claude credential checks and RLM bootstrap are skipped. Startup copies mounted `auth.json` into each service-local `/home/agent/.codex` directory, runs `codex login status`, and executes a lightweight `codex exec` health check. Planner and executor keep separate Codex homes (separate Docker volumes).

## Commit signing

The agent supports signed commits via GPG or SSH keys.

### GPG

1. Export your key: `gpg --armor --export-secret-keys <KEY_ID> > secrets/gpg_private_key.asc` 
(Or if Powershell `gpg --armor --export-secret-keys <KEY_ID> | Out-File -Encoding ascii -FilePath secrets\gpg_private_key.asc`)
2. Set `GIT_COMMIT_SIGNING=gpg` and `GIT_SIGNING_KEY=<KEY_ID>` in `.env`

### SSH

1. Copy your key pair to `secrets/ssh_signing_key` and `secrets/ssh_signing_key.pub`
2. Set `GIT_COMMIT_SIGNING=ssh` in `.env`
3. Register the public key on GitHub for signature verification

Keys are mounted read-only and copied into container-owned paths with proper permissions by the entrypoint script. Windows-exported GPG keys with CRLF/BOM are handled automatically.

## Label protocol

The system uses GitHub issue labels to track workflow state. Labels are auto-created on first run.

| Label | Applied by | Meaning |
|-------|-----------|---------|
| `feature` | Human | Feature request |
| `needs-plan` | Human | Feature needs a plan |
| `planned` | Planner | Plan and tasks created |
| `plan:draft` | Planner | Plan exists, not yet approved |
| `plan:needs-clarification` | Planner | Human input needed |
| `plan:ready` | Human/Planner | Plan approved for task creation |
| `plan:tasks-created` | Planner | All tasks created from plan |
| `task` | Planner | Implementation task |
| `todo` | Planner | Task available for claiming |
| `in-progress` | Executor | Task claimed and being worked on |
| `claimed-by:<id>` | Executor | Which executor owns the task |
| `done` | Executor | Task complete, PR merged |
| `blocked` | Executor | Task needs human intervention |

## Project structure

```
solution/
  src/
    index.ts          Entry point - parses role, registers SIGTERM handler, starts loop
    planner.ts        Planner polling loop (plan creation + task decomposition)
    executor.ts       Executor polling loop (claim -> implement -> review -> merge)
    agent-cli.ts      Provider dispatcher (claude/codex)
    agent-auth.ts     Shared fatal authentication detection helpers
    claude.ts         Claude Code CLI wrapper (headless -p mode)
    codex.ts          Codex CLI wrapper (codex exec / resume mode)
    github.ts         gh CLI wrapper (issues, PRs, labels, comments, claim protocol)
    git.ts            git CLI wrapper (sync, worktree, push)
    signing.ts        Signing key validation
    state.ts          Local state files + GitHub recovery
    config.ts         Env var parsing + validation
    types.ts          Shared type definitions
    logger.ts         Structured logging
  tests/unit/         Unit tests (Vitest)
  prompts/
    plan.md           Planner: create plans from features
    tasks.md          Planner: decompose plans into tasks
    exec.md           Executor: implement code changes
    review.md         Executor: diagnose and fix CI failures
  scripts/
    entrypoint.sh     Credential setup + provider-specific health checks
  Dockerfile          Multi-stage build (node:24-slim)
  docker-compose.yml  Planner + executor services
  .env.example        Configuration template
```

## Development

```bash
cd solution

# Install dependencies
npm install

# Run tests
npm test

# Type check
npm run typecheck

# Build
npm run build

# Run locally (outside Docker)
node dist/index.js planner
node dist/index.js executor
```

### Testing

The project has unit tests covering all modules. All CLI calls (`git`, `gh`, `claude`, `codex`) are mocked via `vi.mock('execa')`.

```bash
# Run all tests
npm test

# Run a specific test file
npx vitest run tests/unit/executor.test.ts

# Run in watch mode
npx vitest
```

## Safety controls

- **Max turns hint per invocation**: Passed to provider adapters (native in Claude, informational in Codex)
- **30-minute timeout**: Hard kill per provider invocation
- **Review loop**: Max 3 CI fix attempts before marking `blocked`
- **Circuit breaker**: 3 consecutive iteration failures on the same task marks it `blocked`
- **Graceful shutdown**: SIGTERM finishes the current iteration before exiting
- **Nonce-based claiming**: Prevents two executors from working the same task
- **Non-root container**: Runs as `agent` user inside Docker
- **Read-only key mounts**: Signing keys are mounted read-only, copied with proper permissions
- **RLM fail-fast mode**: Optional startup hard-fail when plugin setup is required (`RLM_PLUGIN_REQUIRED=true`)



