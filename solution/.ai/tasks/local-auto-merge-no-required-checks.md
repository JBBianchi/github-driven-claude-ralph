# Task: Auto-merge when no required checks or reviews

- **Issue:** —
- **Status:** completed
- **Started:** 2026-03-05T22:31:07.4193516+01:00
- **Completed:** 2026-03-05T22:32:20.1837808+01:00

## Objective

Ensure executor merges PRs when GitHub reports no required checks and no blocking review requirements.

## Work performed

- Identified current behavior where `gh pr checks` error `no checks reported` is treated as pending.
- Located `getPRStatus` and related tests for check/review gating.
- Added unit tests for:
  - no checks reported + no review required => `mergeable`
  - no checks reported + review required => `pending`
- Updated `src/github.ts` so `no checks reported` is treated as passing checks.
- Ran `npm.cmd run typecheck` and `npm.cmd test` successfully.

## Decisions made

- Use test-first change in `tests/unit/github.test.ts`, then update `src/github.ts`.
- Preserve review gating: `REVIEW_REQUIRED` and `CHANGES_REQUESTED` still block merge.

## Blockers / uncertainties

- `gh` may transiently report no checks before check suites appear in some repos.

## Outcome

Executor now auto-merges when there are no reported checks and no blocking review requirement.
