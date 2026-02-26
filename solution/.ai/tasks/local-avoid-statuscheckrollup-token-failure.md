# Task: Avoid statusCheckRollup token failure in PR polling

- **Issue:** —
- **Status:** completed
- **Started:** 2026-02-26T19:20:28+01:00
- **Completed:** 2026-02-26T19:22:34+01:00

## Objective

Remove executor dependency on GraphQL PR fields that are inaccessible with constrained PATs and keep PR polling functional.

## Work performed

- Confirmed failure comes from `gh pr list/view --json ...statusCheckRollup`.
- Refactored PR discovery/status logic in `src/github.ts` to stop querying `statusCheckRollup`.
- Switched status derivation to `mergeStateStatus` + `mergeable` + `reviewDecision`.
- Added handling for missing `mergeStateStatus` by treating it as `pending`.
- Updated unit tests in `tests/unit/github.test.ts` to match the new JSON payload and status derivation logic.
- Ran `npm run typecheck` and `npm test` successfully.

## Decisions made

- Prefer lower-scope PR fields (`mergeStateStatus`) over `statusCheckRollup` to avoid PAT permission failures in GraphQL.
- Keep conservative behavior: if status cannot be confidently derived, return `pending` instead of merging.

## Blockers / uncertainties

- None currently.

## Outcome

Completed. Executor no longer crashes on `statusCheckRollup` GraphQL permission errors for branch PR polling.