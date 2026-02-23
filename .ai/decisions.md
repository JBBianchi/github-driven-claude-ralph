- DECISION: Implement as one codebase with two service entrypoints (`planner` and `executor`) plus shared core libraries.
- DATE: 2026-02-22
- RATIONALE: Minimizes duplicated logic for GitHub/git/state models while preserving runtime separation.
- ALTERNATIVES: Two independent repos/services.
- CONSEQUENCES: Cleaner shared tests, but requires strict module boundaries to avoid role leakage.

- DECISION: Use explicit GitHub label/state machine as workflow contract, with idempotency keys in issue body metadata.
- DATE: 2026-02-22
- RATIONALE: Keeps GitHub as source of truth and allows safe resume after restarts.
- ALTERNATIVES: External queue/DB or in-memory state.
- CONSEQUENCES: Requires careful taxonomy governance and migration handling for labels.

- DECISION: Executor performs all code changes in task worktrees; canonical clone is ref source and worktree parent only.
- DATE: 2026-02-22
- RATIONALE: Preserves clean base repo and aligns with persistence/resume requirements.
- ALTERNATIVES: Branching directly in base checkout.
- CONSEQUENCES: Need robust worktree garbage-collection and corruption-recovery routines.

- DECISION: Tokens and sensitive credentials MUST use Docker Compose secrets (`secrets:` block), never plain environment variables. GH_TOKEN is sourced via `secrets: environment: GH_TOKEN`. Claude credentials via mounted file. Build-time secrets (if ever needed) must use BuildKit `--mount=type=secret`. No secrets baked into the image.
- DATE: 2026-02-23
- RATIONALE: Plain env vars are visible in `docker inspect`, process listings, and logs. Docker secrets are mounted as tmpfs files at `/run/secrets/` and are not exposed in container metadata.
- ALTERNATIVES: Plain env vars (rejected — insecure), build-time ARGs (rejected — baked into layers).
- CONSEQUENCES: Entrypoint reads token from `/run/secrets/GH_TOKEN`. Strong startup validation needed with clear fatal errors on missing secrets.

- DECISION: Use Claude Code runtime with mounted `~/.claude/.credentials.json` for both planner and executor. ANTHROPIC_API_KEY env var is NOT used.
- DATE: 2026-02-23
- RATIONALE: Matches deployment requirement and avoids introducing parallel provider complexity in v1. Credentials file supports Claude's auth flow.
- ALTERNATIVES: ANTHROPIC_API_KEY env var, hybrid provider mode.
- CONSEQUENCES: Container startup must validate credential file presence and readable permissions. Mount must be configured in docker-compose.

- DECISION: Executor auto-merges when configured merge gates pass.
- DATE: 2026-02-22
- RATIONALE: Maximizes autonomous throughput while preserving branch protection safeguards.
- ALTERNATIVES: Human-only merge.
- CONSEQUENCES: Merge-gate logic must exactly mirror repository policy to avoid unsafe merges.

- DECISION: Commit signing is a tri-state toggle (`GIT_COMMIT_SIGNING=off|gpg|ssh`); when enabled, missing/invalid signing setup is fatal. Signing keys are mounted read-only and copied to container-owned paths (Windows compatibility).
- DATE: 2026-02-23
- RATIONALE: GPG and SSH are both supported by GitHub for verified commits. SSH is simpler and avoids gpg-agent headaches. Copy-then-chmod handles Windows mount permission issues.
- ALTERNATIVES: GPG-only boolean toggle, always sign, best-effort with warning.
- CONSEQUENCES: Requires explicit startup self-test for key import. Entrypoint handles key copy/import for both GPG and SSH.

- DECISION: v1 deployment scope is one isolated executor per repo/host.
- DATE: 2026-02-22
- RATIONALE: Simplifies claim semantics and operational reliability for first release.
- ALTERNATIVES: Multi-executor/multi-host distributed workers.
- CONSEQUENCES: Parallelism is intentionally limited in v1; scale-out deferred.

- DECISION: Missing workflow labels are auto-created at startup.
- DATE: 2026-02-22
- RATIONALE: Reduces manual setup friction and avoids failed bootstraps in fresh repos.
- ALTERNATIVES: Fail-fast when labels are missing.
- CONSEQUENCES: Bootstrap requires idempotent label reconciliation.

- DECISION: Dedicated review loop with separate prompt (review.md) for CI failure diagnosis.
- DATE: 2026-02-23
- RATIONALE: CI failure interpretation is a distinct cognitive task from implementation. Separate prompt keeps focus tight. Max 3 attempts before marking blocked.
- ALTERNATIVES: Re-run full executor prompt (original plan).
- CONSEQUENCES: Adds a review phase to executor loop. Requires getPRCheckDetails() in github.ts.
