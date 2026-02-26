# Task: Handle Claude OAuth expiry as fatal

- **Issue:** —
- **Status:** completed
- **Started:** 2026-02-26T19:13:20+01:00
- **Completed:** 2026-02-26T19:17:08+01:00

## Objective

Detect expired Claude authentication errors and stop planner/executor loops instead of repeatedly retrying task iterations.

## Work performed

- Added Claude auth error detection in `src/claude.ts` and throw a fatal error marker when OAuth/session authentication is expired.
- Updated executor iteration flow to:
  - skip PR monitoring when Claude implementation fails non-fatally,
  - skip review push when Claude review invocation fails,
  - rethrow fatal Claude auth failures so the loop stops.
- Updated planner iteration flow to rethrow fatal Claude auth failures from Claude-invoking phases.
- Added/updated unit tests for Claude auth failure detection and planner/executor fatal propagation behavior.
- Ran `npm run typecheck` and `npm test` successfully.

## Decisions made

- Treat Claude OAuth expiry as a fatal operational condition (requires credential refresh), not as a normal per-task failure.
- Keep non-auth Claude failures as non-fatal so normal retry behavior remains intact.

## Blockers / uncertainties

- None currently.

## Outcome

Completed. Expired Claude auth now causes the agent process to fail fast with a clear message instead of repeatedly retrying tasks.