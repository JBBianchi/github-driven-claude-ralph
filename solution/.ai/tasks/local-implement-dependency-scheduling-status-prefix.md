# Task: Add planner-owned dependency scheduling with status-prefixed labels

- **Issue:** #—
- **Status:** completed
- **Started:** 2026-02-26T17:43:30+01:00
- **Completed:** 2026-02-26T17:52:30+01:00

## Objective

Implement dependency-aware task scheduling in planner while keeping executor logic dependency-agnostic, and migrate workflow status labels to `status:*`.

## Work performed

- Updated status label namespace across runtime code to `status:todo`, `status:in-progress`, `status:blocked`, `status:done`, `status:waiting`.
- Extended `AgentMeta` and parser support for `depends_on` arrays.
- Extended GitHub issue listing wrapper to support `state` selection (`open|closed|all`) and `updatedAt` retrieval.
- Added planner readiness scheduling phase: computes unresolved dependencies from `depends_on` against tasks labeled `status:done`, transitions tasks between `status:waiting` and `status:todo`.
- Added planner stale waiting guard: comments when waiting tasks remain blocked beyond threshold.
- Kept executor dependency-agnostic; claim path still operates only on runnable tasks, with compatibility fallback to legacy `todo` labels.
- Added compatibility fallback in executor state recovery for legacy `in-progress` labels.
- Updated task decomposition prompt to emit `depends_on` and create tasks in `status:waiting`.
- Updated unit tests for new label schema and planner scheduling behavior.

## Decisions made

- Keep dependency source of truth in `agent-meta` (`depends_on`), use `status:waiting` as derived scheduling state.
- Maintain a short compatibility window for legacy labels (`todo`, `in-progress`) in executor/runtime paths.
- Preserve executor simplicity: no dependency parsing in executor hot path.

## Blockers / uncertainties

- None.

## Outcome

Implementation completed. `npm run typecheck` and `npm test` both pass.
