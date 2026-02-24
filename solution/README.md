# GitHub-Driven Claude Agent

A Dockerized TypeScript orchestration layer that automates software development using Claude Code CLI. It monitors GitHub issues, creates implementation plans, decomposes them into tasks, writes code in isolated worktrees, opens PRs, and handles CI review loops — all autonomously.

## How it works

The system runs two polling loops inside Docker containers:

**Planner** reads GitHub issues labeled `feature` + `needs-plan`, invokes Claude Code to produce a plan issue, then decomposes approved plans into task issues.

**Executor** claims a `todo` task via a nonce-based lease protocol, checks out a git worktree, invokes Claude Code to implement the changes, creates a PR, monitors CI, and runs a review loop (up to 3 attempts) if checks fail. On success it squash-merges the PR and closes the task.

```
Human creates feature issue
        |
        v
  +-----------+     Claude reads issue, analyzes codebase,
  |  Planner  | --> creates plan issue, decomposes into tasks
  +-----------+
        |
        v
  +-----------+     Claude claims task, writes code in worktree,
  |  Executor | --> creates PR, fixes CI failures, merges
  +-----------+
        |
        v
  Merged PR + closed issue
```

All reasoning happens inside Claude Code (invoked via `claude -p` in headless mode). The TypeScript layer only handles deterministic work: polling, task claiming, worktree management, label transitions, PR monitoring, and state recovery.

## Prerequisites

- **Docker** and **Docker Compose**
- A **GitHub personal access token** with `repo` scope
- A **Claude credentials file** (`~/.claude/.credentials.json`)

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
| `CLAUDE_CREDENTIALS_FILE` | Absolute path to your `~/.claude/.credentials.json` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_BRANCH` | `main` | Branch to sync against |
| `PLANNER_POLL_INTERVAL_SECONDS` | `120` | Seconds between planner iterations |
| `PLANNER_MAX_TURNS` | `30` | Max Claude tool-use turns per planner invocation |
| `EXECUTOR_ID` | `executor-01` | Unique ID for this executor instance |
| `EXECUTOR_POLL_INTERVAL_SECONDS` | `60` | Seconds between executor iterations |
| `EXECUTOR_MAX_TURNS` | `50` | Max Claude tool-use turns per executor invocation |
| `VALIDATION_COMMAND` | _(empty)_ | Command for Claude to run before committing (e.g. `npm test`) |
| `GIT_COMMIT_SIGNING` | `off` | Commit signing mode: `off`, `gpg`, or `ssh` |
| `GIT_SIGNING_KEY` | _(empty)_ | GPG key ID (required when `gpg` mode) |
| `SIGNING_KEYS_PATH` | `./secrets` | Host path to signing key files |

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
    index.ts          Entry point — parses role, registers SIGTERM handler, starts loop
    planner.ts        Planner polling loop (plan creation + task decomposition)
    executor.ts       Executor polling loop (claim -> implement -> review -> merge)
    claude.ts         Claude Code CLI wrapper (headless -p mode)
    github.ts         gh CLI wrapper (issues, PRs, labels, comments, claim protocol)
    git.ts            git CLI wrapper (sync, worktree, push)
    signing.ts        Signing key validation
    state.ts          Local state files + GitHub recovery
    config.ts         Env var parsing + validation
    types.ts          Shared type definitions
    logger.ts         Structured logging
  tests/unit/         124 unit tests (Vitest)
  prompts/
    plan.md           Planner: create plans from features
    tasks.md          Planner: decompose plans into tasks
    exec.md           Executor: implement code changes
    review.md         Executor: diagnose and fix CI failures
  scripts/
    entrypoint.sh     Credential setup (git, gh, gpg/ssh, Claude)
  Dockerfile          Multi-stage build (node:20-slim)
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

The project has 124 unit tests covering all modules. All CLI calls (`git`, `gh`, `claude`) are mocked via `vi.mock('execa')`.

```bash
# Run all tests
npm test

# Run a specific test file
npx vitest run tests/unit/executor.test.ts

# Run in watch mode
npx vitest
```

## Safety controls

- **Max turns per invocation**: Caps Claude's tool calls (30 planner, 50 executor)
- **30-minute timeout**: Hard kill per Claude invocation
- **Review loop**: Max 3 CI fix attempts before marking `blocked`
- **Circuit breaker**: 3 consecutive iteration failures on the same task marks it `blocked`
- **Graceful shutdown**: SIGTERM finishes the current iteration before exiting
- **Nonce-based claiming**: Prevents two executors from working the same task
- **Non-root container**: Runs as `agent` user inside Docker
- **Read-only key mounts**: Signing keys are mounted read-only, copied with proper permissions
