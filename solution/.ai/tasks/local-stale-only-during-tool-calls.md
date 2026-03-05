# Task: Restrict Claude stale detection to tool-call phases

- **Issue:** #N/A (local request)
- **Status:** completed
- **Started:** 2026-03-04T11:20:08.4056171+01:00
- **Completed:** 2026-03-04T11:31:37.5039646+01:00

## Objective

Change stale heartbeat behavior so it only applies while tool subprocess activity is visible in the process snapshot, while preserving existing timeout behavior.

## Work performed

- Inspected `src/claude.ts` stale/timeout logic and `tests/unit/claude.test.ts` coverage.
- Confirmed current log behavior in `logs/executor-02/claude.log` where stale kills happen around 5 minutes.
- Updated `src/claude.ts` heartbeat logic to gate stale counting and stale-kill on `toolActive` (`processSnapshot !== null`).
- Added `toolActive` to structured heartbeat logger payload in `src/claude.ts`.
- Updated `tests/unit/claude.test.ts` with deterministic `/proc` mocks for tool-activity simulation.
- Replaced stale tests to cover:
  - no kill when no tool activity is visible,
  - kill after stale heartbeats during tool activity,
  - stale reset when tool snapshot changes during tool activity.
- Extended heartbeat log assertion to validate `toolActive: false` in non-tool mode.
- Ran required checks:
  - `npm.cmd run typecheck` (pass),
  - `npm.cmd test` (fails on pre-existing model-related expectations in `config.test.ts`, `planner.test.ts`, `executor.test.ts`, and one existing model-argument test in `claude.test.ts`).
- Ran focused validation of new stale tests:
  - `npm.cmd run test -- tests/unit/claude.test.ts -t "tool activity|no tool activity|stale counter"` (pass).

## Decisions made

- Use `processSnapshot !== null` as the sole tool-activity signal.
- Keep timeout (30 minutes), heartbeat cadence (30s), and stale threshold (10 heartbeats) unchanged.

## Blockers / uncertainties

- None.

## Outcome

Requested stale-behavior change is implemented and covered by targeted tests. Full-suite failures are unrelated to this change and are centered on existing model-configuration expectations.

