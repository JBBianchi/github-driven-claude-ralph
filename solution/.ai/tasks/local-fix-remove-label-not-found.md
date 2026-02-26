# Task: Fix planner scheduling failure on missing legacy labels

- **Issue:** #—
- **Status:** completed
- **Started:** 2026-02-26T18:02:40+01:00
- **Completed:** 2026-02-26T18:10:10+01:00

## Objective

Prevent `gh issue edit --remove-label` failures when optional legacy labels are missing during readiness scheduling.

## Work performed

- Updated `editIssueLabels` in `src/github.ts` to handle `'<label>' not found` failures on remove-label:
  - parse missing labels from error message
  - retry removal with only existing labels
  - no-op when all requested removals are missing
- Added unit tests in `tests/unit/github.test.ts` for partial and full missing-label remove scenarios.
- Re-ran validation checks.

## Decisions made

- Keep compatibility removals (legacy labels) but make removals fault-tolerant instead of removing compatibility behavior.

## Blockers / uncertainties

- None.

## Outcome

Fix implemented. `npm run typecheck` and `npm test` pass.
