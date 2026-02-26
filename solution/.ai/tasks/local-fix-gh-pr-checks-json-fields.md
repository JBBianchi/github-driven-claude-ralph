# Task: Fix gh pr checks JSON field mismatch

- **Issue:** —  
- **Status:** completed
- **Started:** 2026-02-26T23:16:59.6900790+01:00
- **Completed:** 2026-02-26T23:17:49.8095842+01:00

## Objective

Fix executor failures caused by unsupported `gh pr checks --json` fields while preserving actionable check details in logs/comments.

## Work performed

- Investigated failing command and matched it to `getPRCheckDetails` in `src/github.ts`.
- Updated `getPRCheckDetails` to request `--json name,state,link` instead of unsupported `conclusion,detailsUrl`.
- Normalized check details formatting to tolerate missing fields (`UNKNOWN`, `n/a`).
- Updated `tests/unit/github.test.ts` expectations to use `state/link` payloads and added a defensive missing-field test.
- Ran `npm run typecheck` and `npm test`.

## Decisions made

- Switch from unsupported fields (`conclusion`, `detailsUrl`) to supported fields exposed by this GH CLI (`state`, `link`) and normalize output formatting in code.

## Blockers / uncertainties

- None.

## Outcome

Executor no longer depends on unsupported GH CLI JSON fields for `pr checks`, preventing this iteration failure and associated circuit-breaker escalation.
