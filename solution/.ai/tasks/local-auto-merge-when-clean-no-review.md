# Task: Auto-merge when checks pass and no review is pending

- **Issue:** #—
- **Status:** completed
- **Started:** 2026-02-27T11:56:18.1500714+01:00
- **Completed:** 2026-02-27T11:58:43.7897155+01:00

## Objective

Allow executor to merge automatically when PR checks are passing and there is no blocking review state, instead of requiring explicit APPROVED.

## Work performed

- Updated `tests/unit/github.test.ts` first (TDD) to reflect auto-merge behavior when checks are clean and no blocking review decision exists.
- Added explicit review-gating tests for `REVIEW_REQUIRED` and `CHANGES_REQUESTED` remaining pending.
- Updated `src/github.ts` `getPRStatus` logic to only block merge on explicit blocking review states instead of requiring `APPROVED`.
- Ran required checks in order: `npm run typecheck`, `npm test`.

## Decisions made

- Kept `pending` behavior for explicit blocking review states only (`REVIEW_REQUIRED`, `CHANGES_REQUESTED`).
- Treat empty/null/no-review-decision as non-blocking when checks are passing, enabling auto-merge.

## Blockers / uncertainties

- Local sandbox blocked Vitest/esbuild spawn (`spawn EPERM`); reran `npm test` outside sandbox to complete required validation.

## Outcome

Executor can now auto-merge when checks are passing and there is no blocking review decision from GitHub.
