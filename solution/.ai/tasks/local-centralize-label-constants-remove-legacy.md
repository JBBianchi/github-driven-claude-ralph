# Task: Centralize label constants and remove legacy status labels

- **Issue:** #—
- **Status:** completed
- **Started:** 2026-02-26T18:12:30+01:00
- **Completed:** 2026-02-26T18:19:30+01:00

## Objective

Eliminate legacy status label usage and consolidate all workflow label values in one shared constants module.

## Work performed

- Added `src/labels.ts` as the single source of truth for workflow labels and claimed-by labels.
- Refactored `src/github.ts`, `src/planner.ts`, `src/executor.ts`, and `src/state.ts` to consume shared label constants/functions only.
- Removed all runtime fallback logic for legacy labels (`todo`, `in-progress`).
- Updated affected unit tests to match strict `status:*` behavior.

## Decisions made

- Keep only canonical status labels: `status:todo`, `status:in-progress`, `status:blocked`, `status:done`, `status:waiting`.
- Keep missing-label remove retry in `editIssueLabels` as a generic guard, but no legacy label references remain.

## Blockers / uncertainties

- None.

## Outcome

Implementation completed and validated with `npm run typecheck` and `npm test`.
