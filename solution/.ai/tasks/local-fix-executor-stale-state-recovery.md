# Task: Auto-clear stale executor task state

- **Issue:** —
- **Status:** completed
- **Started:** 2026-02-26T18:06:59.2275711+01:00
- **Completed:** 2026-02-26T18:08:09.1928066+01:00

## Objective

Prevent the executor from getting stuck retrying a stale active task when the corresponding GitHub issue is no longer open.

## Work performed

- Inspected executor state recovery and task lookup flow in `src/executor.ts` and `src/state.ts`.
- Identified that missing active task currently logs and returns without clearing persisted state.
- Added stale-state recovery in `src/executor.ts` to clear persisted executor state when `activeTaskId` cannot be found among open task issues.
- Added unit test `clears stale state when active task issue is missing` in `tests/unit/executor.test.ts`.
- Ran required validations: `npm run typecheck` then `npm test`.

## Decisions made

- Add explicit stale-state cleanup when active task cannot be found among open task issues.
- Add unit test coverage in `tests/unit/executor.test.ts` before implementation.

## Blockers / uncertainties

- None.

## Outcome

Executor now self-recovers from stale persisted task IDs, preventing repeated missing-task loops after issues are closed. All tests and type checks pass.
