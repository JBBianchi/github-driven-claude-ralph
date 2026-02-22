# Dockerized Planner/Executor Implementation Plan (v1)

Date: 2026-02-22
Status: Decision lock complete

## 1) Goals

- Run `planner` and `executor` as restart-safe containers locally or on a server.
- Use polling only (no webhooks, no GitHub Actions).
- Keep a persistent canonical clone and persistent task worktrees.
- Keep GitHub Issues/Labels/PRs as source of truth for workflow state.
- Support mounted Claude credentials (`~/.claude/.credentials.json`).
- Support configurable git identity, PAT auth, and optional/required GPG commit signing.
- Keep secrets runtime-injected only (env/secrets/files), never image-baked.

## 2) Non-goals (v1)

- No webhooks, GitHub App migration, or event queue outside GitHub.
- No multi-repo orchestration.
- No cross-repo dependency resolver.

## 3) Architecture

### 3.1 Services

- `planner` service:
  - Syncs canonical repo.
  - Creates/updates Plan issue(s).
  - Creates Task issues only after `plan:ready`.
- `executor` service (single isolated instance in v1):
  - Claims task issues.
  - Creates/reuses worktree + branch.
  - Applies changes, validates, commits, pushes, opens/reuses PR.
  - Monitors checks/reviews; auto-merges when policy allows.

### 3.2 Storage contract

- Shared persistent volumes:
  - `repo_data` -> `/workspace/repo`
  - `worktrees_data` -> `/workspace/worktrees` (executor only)
  - `state_data` -> `/workspace/state` (both)
- Invariants:
  - `/workspace/repo` is never used for direct feature coding.
  - All executor code changes happen in `/workspace/worktrees/<task_id>`.
  - Restart resumes state from GitHub + persisted volumes.

### 3.3 Source-of-truth model

- GitHub is canonical for business state:
  - Feature/Plan/Task issue labels.
  - PR status (checks/reviews/merge state).
- Local volumes are operational state only:
  - git objects/worktrees.
  - loop cursors, retry metadata, logs.

## 4) Proposed repository/code layout

```text
src/
  common/
    config.py
    logging.py
    github_client.py
    git_client.py
    models.py
    labels.py
    idempotency.py
  planner/
    service.py
    plan_generator.py
    task_generator.py
  executor/
    service.py
    claimer.py
    worktree_manager.py
    implementer.py
    pr_manager.py
    merge_gate.py
  bootstrap/
    ensure_labels.py
    ensure_repo.py
ops/
  docker/
    Dockerfile
    entrypoint.sh
    planner.sh
    executor.sh
  compose/
    docker-compose.yml
    .env.example
tests/
  unit/
  integration/
  system/
```

One codebase, two entrypoints, shared adapters.

## 5) Runtime configuration contract

### 5.1 Common env

- `REPO_URL`
- `REPO_SLUG` (`org/repo`)
- `BASE_BRANCH` (default `main`)
- `GITHUB_TOKEN` or `GITHUB_TOKEN_FILE`
- `GIT_AUTHOR_NAME`
- `GIT_AUTHOR_EMAIL`
- `CLAUDE_CREDENTIALS_PATH` (default `/home/app/.claude/.credentials.json`)

### 5.2 Planner env

- `PLANNER_POLL_INTERVAL_SECONDS`

### 5.3 Executor env

- `EXECUTOR_ID`
- `MAX_CONCURRENCY` (set to `1` for v1 single-executor profile)
- `POLL_INTERVAL_SECONDS`
- `VALIDATION_COMMAND` (project-specific test/build command)
- `AUTO_MERGE_ENABLED` (`true|false`, default `true`)

### 5.4 Git auth modes

- HTTPS mode:
  - PAT via `GITHUB_TOKEN` or secret file.
  - Remote URL rewritten to token-authenticated HTTPS at runtime.
- SSH mode:
  - mount private key + known_hosts read-only.
  - token still required for GitHub API operations.

### 5.5 GPG signing controls

- `ENABLE_GPG_SIGNING` (`true|false`)
- `GPG_PRIVATE_KEY_ASC_FILE` (mounted armored private key)
- `GPG_PASSPHRASE_FILE` (optional secret file)
- `GPG_KEY_ID`
- `GNUPGHOME` (default `/workspace/state/gnupg`)

Startup behavior:
- Import key idempotently if file present.
- Configure git signing key and `commit.gpgsign=true` when enabled.
- If `ENABLE_GPG_SIGNING=true` and signing setup fails, fail fast.
- If `ENABLE_GPG_SIGNING=false`, continue without signing.

Windows host guidance:
- Export armored key on host and mount file as-is.
- Normalize line endings if import fails; keep ASCII armor content intact.
- Keep passphrase in secret file, not plain env where possible.

## 6) Label/state machine

### 6.1 Feature issue labels

- Input: `feature`, `needs-plan`
- Planner outputs:
  - `planned` after task creation
  - `blocked:clarification` if `plan:needs-clarification`

### 6.2 Plan issue labels

- `plan:draft`
- `plan:needs-clarification`
- `plan:ready`
- `plan:tasks-created`

### 6.3 Task issue labels

- `task`, `todo`
- `in-progress`
- `claimed-by:<executor_id>`
- `blocked`
- `done`

### 6.4 PR labels/status

- `task:<id>`
- `executor:<id>`
- merge gate from branch protection + approvals + checks

## 7) Idempotency contract

Embed machine metadata block in issue bodies and PR body:

```md
<!-- agent-meta
entity: task
task_id: 1234
source_plan_issue: 456
executor_id: ex-01
branch: task/1234-short-slug
worktree: /workspace/worktrees/1234
 -->
```

Rules:
- Create-or-reuse by metadata first, labels second, title third.
- Never create duplicate task for same checklist item if metadata exists.
- Reopening/retry updates same issue/PR where possible.

## 8) Planner loop behavior

1. Bootstrap repo at `/workspace/repo` if missing.
2. On each loop:
   - `git -C /workspace/repo fetch origin`
   - `git -C /workspace/repo checkout <BASE_BRANCH>`
   - `git -C /workspace/repo reset --hard origin/<BASE_BRANCH>`
   - `git -C /workspace/repo clean -fdx`
3. Query GitHub for `feature + needs-plan`.
4. For each feature:
   - create/reuse plan issue (`plan:draft`).
   - generate/update plan content.
   - if uncertain, set `plan:needs-clarification` and stop.
   - if `plan:ready` and tasks not created:
     - create task issues idempotently.
     - update checklist links in plan.
     - set `plan:tasks-created`.
   - update feature label to `planned` once tasks exist.

## 9) Executor loop behavior

1. Pre-loop: `git -C /workspace/repo fetch origin`.
2. Resume claimed tasks:
   - query `task + in-progress + claimed-by:<EXECUTOR_ID>`.
   - ensure worktree/branch/PR exists.
   - continue checks/reviews/merge loop.
3. If capacity available, claim additional `task + todo`.
4. Per active task:
   - create/reuse worktree:
     - `git -C /workspace/repo worktree add /workspace/worktrees/<task_id> -b <branch> origin/<BASE_BRANCH>`
   - implement via Claude provider.
   - run `VALIDATION_COMMAND`.
   - commit (signed if enabled), push, open/reuse PR.
   - poll PR checks + review status.
   - merge only when policy satisfied.
   - mark task `done`, remove `in-progress` labels.

Failure handling:
- Validation failure -> keep `in-progress`, comment diagnostics.
- Merge conflict/check failure -> retry with capped backoff.
- Human dependency -> label `blocked` + explicit comment.

## 10) Claim protocol (single-executor v1)

v1 runs one isolated executor per repo/host, so contention is intentionally absent.

- Query `task + todo`.
- Select oldest eligible task.
- Transition labels (`todo` -> `in-progress`, add `claimed-by:<EXECUTOR_ID>`).
- Re-read issue and verify expected labels before starting work.

Future multi-executor/multi-host support should add explicit distributed locking (Redis/DB) and compare-and-set claim semantics.

## 11) Docker/compose implementation

### 11.1 Dockerfile principles

- Multi-stage image.
- Non-root runtime user.
- Install git, gpg, ssh-client.
- App code copied without secrets.
- Entrypoint validates required env/secrets then starts role.

### 11.2 Compose shape (example)

```yaml
services:
  planner:
    image: agent-loop:latest
    command: ["planner"]
    restart: always
    environment:
      REPO_URL: ${REPO_URL}
      REPO_SLUG: ${REPO_SLUG}
      BASE_BRANCH: ${BASE_BRANCH:-main}
      PLANNER_POLL_INTERVAL_SECONDS: ${PLANNER_POLL_INTERVAL_SECONDS:-60}
      GITHUB_TOKEN_FILE: /run/secrets/github_token
      GIT_AUTHOR_NAME: ${GIT_AUTHOR_NAME}
      GIT_AUTHOR_EMAIL: ${GIT_AUTHOR_EMAIL}
      CLAUDE_CREDENTIALS_PATH: /home/app/.claude/.credentials.json
    volumes:
      - repo_data:/workspace/repo
      - state_data:/workspace/state
      - ${CLAUDE_CREDENTIALS_FILE}:/home/app/.claude/.credentials.json:ro
    secrets:
      - github_token

  executor:
    image: agent-loop:latest
    command: ["executor"]
    restart: always
    environment:
      REPO_URL: ${REPO_URL}
      REPO_SLUG: ${REPO_SLUG}
      BASE_BRANCH: ${BASE_BRANCH:-main}
      EXECUTOR_ID: ${EXECUTOR_ID}
      MAX_CONCURRENCY: ${MAX_CONCURRENCY:-1}
      POLL_INTERVAL_SECONDS: ${POLL_INTERVAL_SECONDS:-30}
      VALIDATION_COMMAND: ${VALIDATION_COMMAND}
      AUTO_MERGE_ENABLED: ${AUTO_MERGE_ENABLED:-true}
      GITHUB_TOKEN_FILE: /run/secrets/github_token
      GIT_AUTHOR_NAME: ${GIT_AUTHOR_NAME}
      GIT_AUTHOR_EMAIL: ${GIT_AUTHOR_EMAIL}
      CLAUDE_CREDENTIALS_PATH: /home/app/.claude/.credentials.json
      ENABLE_GPG_SIGNING: ${ENABLE_GPG_SIGNING:-false}
      GPG_PRIVATE_KEY_ASC_FILE: /run/secrets/gpg_private_key
      GPG_PASSPHRASE_FILE: /run/secrets/gpg_passphrase
      GPG_KEY_ID: ${GPG_KEY_ID:-}
    volumes:
      - repo_data:/workspace/repo
      - worktrees_data:/workspace/worktrees
      - state_data:/workspace/state
      - ${CLAUDE_CREDENTIALS_FILE}:/home/app/.claude/.credentials.json:ro
    secrets:
      - github_token
      - gpg_private_key
      - gpg_passphrase

volumes:
  repo_data:
  worktrees_data:
  state_data:

secrets:
  github_token:
    file: ./secrets/github_token.txt
  gpg_private_key:
    file: ./secrets/gpg_private_key.asc
  gpg_passphrase:
    file: ./secrets/gpg_passphrase.txt
```

## 12) Security model

- Never pass PAT/GPG private key through image build args.
- Prefer `_FILE` env pattern and Docker secrets.
- Validate secret presence at startup and fail fast with explicit error.
- Redact secret-bearing config in logs.
- Mount `.credentials.json` read-only and verify file mode/ownership at startup.

## 13) Test strategy (required for v1 acceptance)

### 13.1 Unit

- Config parsing and precedence (`ENV` vs `_FILE`).
- Label transition guards.
- Idempotency key matching.
- GPG setup error handling.

### 13.2 Integration (local git + mocked GitHub)

- Planner creates/updates exactly one plan per feature.
- Planner creates tasks once when `plan:ready`.
- Executor resumes existing worktree/branch/PR after restart.
- Executor handles failed checks without duplicate PR creation.

### 13.3 System (docker compose)

- Cold start bootstraps repo and loops successfully.
- Restart safety for planner and executor.
- Single executor preserves exactly-once task progression across restarts.
- Missing secrets cause deterministic startup failure.

### 13.4 Contract tests

- Branch naming `task/<id>-<slug>`.
- Worktree path `/workspace/worktrees/<id>`.
- Required labels and metadata block format.

## 14) Milestones with acceptance criteria

- M0 Decision lock:
  - Claude Code runtime, auto-merge, GPG toggle semantics, single-executor scope, and label auto-create confirmed.
- M1 Core adapters:
  - GitHub and git adapters pass unit/integration tests.
- M2 Planner MVP:
  - Feature->Plan->Task lifecycle works end-to-end in integration tests.
- M3 Executor MVP:
  - Task->Worktree->PR lifecycle works, resume/idempotency validated.
- M4 Security hardening:
  - Secret loading, redaction, signing flows validated.
- M5 System validation:
  - Compose restart/isolation tests passing.
- M6 Production readiness:
  - Runbook and operational dashboards/log filters defined.

## 15) Risks and mitigations

- Race conditions in task claiming:
  - Mitigation: single isolated executor per repo/host in v1 + post-claim verification.
- Provider/tooling drift (Claude/GitHub APIs):
  - Mitigation: adapter interfaces + provider-specific contract tests.
- GPG setup fragility across hosts:
  - Mitigation: startup self-test and explicit signing enable/disable flag.
- Repo policy mismatch (branch protection/review rules):
  - Mitigation: merge gate reads repository settings and enforces superset checks.

## 16) Immediate next implementation steps

1. Scaffold codebase and config model.
2. Implement and test git/GitHub adapters first.
3. Implement planner loop with idempotent plan/task creation.
4. Implement executor loop with resume and PR monitoring.
5. Add compose profiles and system test harness.
6. Add startup validation for Claude credentials, PAT, and optional GPG signing.

## 17) Decision lock (confirmed)

1. Claude runtime mode: Claude Code with mounted `~/.claude/.credentials.json`.
2. Merge authority: Executor auto-merges when merge gates pass.
3. GPG policy: Signing is controlled by a flag; when enabled, startup fails if GPG is unavailable.
4. Deployment scope: Single/isolated executor per repo/host for v1.
5. Label governance: Auto-create missing labels.
