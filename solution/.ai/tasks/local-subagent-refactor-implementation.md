# Task: Implement Claude sub-agent integration

- **Issue:** #— (local implementation request)
- **Status:** completed
- **Started:** 2026-03-04T17:47:00.0000000+01:00
- **Completed:** 2026-03-04T17:56:21.5757858+01:00

## Objective

Implement a safe, opt-in integration path for Claude custom sub-agents across planner and executor invocations.

## Work performed

- Added `claudeSubagentsEnabled` to runtime config and env parsing in `src/types.ts` and `src/config.ts`.
- Added `CLAUDE_SUBAGENTS_ENABLED` wiring to `.env.example`, `docker-compose.yml`, and `README.md`.
- Added `ClaudeSubagentDefinition`/`ClaudeSubagentMap` types to `src/types.ts`.
- Added role-specific sub-agent definitions and resolver helper in `src/subagents.ts`.
- Updated `invokeClaude` in `src/claude.ts` to pass `--agents <json>` when provided.
- Wired planner invocations to pass sub-agents when enabled in `src/planner.ts`.
- Wired executor implementation/review/conflict invocations to pass sub-agents when enabled in `src/executor.ts`.
- Added/updated tests:
  - `tests/unit/claude.test.ts` (`--agents` argument handling)
  - `tests/unit/config.test.ts` (`CLAUDE_SUBAGENTS_ENABLED`)
  - `tests/unit/planner.test.ts` (planner receives sub-agent map)
  - `tests/unit/executor.test.ts` (executor receives sub-agent map)
  - Updated all Config test fixtures with `claudeSubagentsEnabled`.

## Decisions made

- Sub-agents are feature-flagged (`CLAUDE_SUBAGENTS_ENABLED=false` by default) to preserve current behavior.
- Kept orchestrator state machine unchanged; only Claude invocation payload changed when enabled.
- Injected sub-agents via CLI `--agents` JSON instead of requiring on-disk `.claude/agents` files.

## Blockers / uncertainties

- None during implementation. Local test execution requires escalation in this environment due sandbox `spawn EPERM` for Vitest/esbuild.

## Outcome

Custom Claude sub-agent integration is implemented and covered by tests, with no behavior change unless explicitly enabled.
