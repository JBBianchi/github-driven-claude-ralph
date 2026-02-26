# Task: Make executor claim oldest todo task first

- **Issue:** N/A
- **Status:** completed
- **Started:** 2026-02-26T17:15:39.5882906+01:00
- **Completed:** 2026-02-26T17:42:00.2128425+01:00

## Objective

Adjust executor task selection so idle claim attempts prioritize the oldest `todo` task instead of the newest.

## Work performed

- Updated idle claim logic in `src/executor.ts` to select the oldest `todo` task by issue number before calling `claimTask`.
- Updated `tests/unit/executor.test.ts` to verify the executor claims the oldest task when the task list arrives newest-first.
- Ran required checks: `npm run typecheck` then `npm test`.

## Decisions made

- Used lowest GitHub issue number as the oldest-task signal because issue numbers are monotonic in a repository and available in current issue payloads.

## Blockers / uncertainties

- None.

## Outcome

Executor now prioritizes oldest `todo` tasks during claim; unit and full test suites pass.
