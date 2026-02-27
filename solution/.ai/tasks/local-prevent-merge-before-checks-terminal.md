# Task: Prevent merge before PR checks are terminal

- **Issue:** #—
- **Status:** completed
- **Started:** 2026-02-27T12:21:11.7635975+01:00
- **Completed:** 2026-02-27T12:47:19.4303514+01:00

## Objective

Ensure executor does not merge a PR while CI checks are still pending/in-progress, even when `mergeStateStatus` reports CLEAN.

## Work performed

- Investigated `agent.log` and `gh.log` timeline for PR #29 merge sequence.
- Confirmed merge occurred based on `gh pr view` (`mergeStateStatus: CLEAN`) without querying per-check states.
- Added check-state parsing in `src/github.ts` and wired `getPRStatus` to consult `gh pr checks --json state` before returning `mergeable`.
- Added conservative handling for transient/no-access check queries: keep status `pending` for `no checks reported` and token access errors.
- Updated `tests/unit/github.test.ts` (TDD):
  - `CLEAN + IN_PROGRESS` => `pending`
  - `CLEAN + FAILURE` => `failing`
  - clean passing checks still mergeable with approved or empty review decision
- Ran required checks in order:
  - `npm run typecheck`
  - `npm test`

## Decisions made

- Keep merge-state shortcuts for obvious non-mergeable conditions (`UNSTABLE`, `DIRTY`, unknown/pending), but require explicit check-run terminal state before merge on `CLEAN`.
- Prefer safety when check visibility is uncertain: do not merge if check state cannot be trusted.

## Blockers / uncertainties

- Sandbox blocked Vitest/esbuild process spawn (`spawn EPERM`), so test run required elevated execution.

## Outcome

Executor merge gating now requires checks to be terminal and passing before merge, preventing premature merges while checks are still running.
