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

- DECISION: Secrets are runtime-only via env vars and mounted files (`/run/secrets` + `~/.claude/.credentials.json`), never image build args.
- DATE: 2026-02-22
- RATIONALE: Reduces leakage risk and supports local/server parity.
- ALTERNATIVES: Build-time ARGs or committed config files.
- CONSEQUENCES: Strong startup validation needed with clear fatal errors on missing secrets.

- DECISION: Use Claude Code runtime with mounted `~/.claude/.credentials.json` for both planner and executor.
- DATE: 2026-02-22
- RATIONALE: Matches deployment requirement and avoids introducing parallel provider complexity in v1.
- ALTERNATIVES: Anthropic API-only or hybrid provider mode.
- CONSEQUENCES: Container startup must validate credential file presence and readable permissions.

- DECISION: Executor auto-merges when configured merge gates pass.
- DATE: 2026-02-22
- RATIONALE: Maximizes autonomous throughput while preserving branch protection safeguards.
- ALTERNATIVES: Human-only merge.
- CONSEQUENCES: Merge-gate logic must exactly mirror repository policy to avoid unsafe merges.

- DECISION: GPG signing is toggleable; when enabled, missing/invalid signing setup is fatal.
- DATE: 2026-02-22
- RATIONALE: Supports both strict compliance workflows and simpler local runs.
- ALTERNATIVES: Always sign or best-effort with warning.
- CONSEQUENCES: Requires explicit startup self-test for GPG key import and signing capability.

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
