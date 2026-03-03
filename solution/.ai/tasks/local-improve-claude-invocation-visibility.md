# Task: Improve Claude invocation visibility for long-running validations

- **Issue:** #—
- **Status:** completed
- **Started:** 2026-03-03T16:03:30.0000000+01:00
- **Completed:** 2026-03-03T16:04:49.0668989+01:00

## Objective

Make executor runs less opaque by recording live Claude invocation progress details in logs while commands are still running.

## Work performed

- Reviewed current `src/claude.ts` behavior and executor log files.
- Updated `src/claude.ts` to track Claude subprocess PID and streamed stdout/stderr byte counts.
- Added periodic heartbeat entries to `claude.log` while invocation is running.
- Extended invocation lifecycle log context with PID and byte counters for started/heartbeat/success/failure events.
- Added unit test coverage in `tests/unit/claude.test.ts` for streamed byte-counter heartbeat logging.

## Decisions made

- Focused on runtime observability instead of changing task execution semantics.
- Kept existing 30-minute global timeout unchanged, but exposed enough telemetry to distinguish "slow" from "stalled" runs.

## Blockers / uncertainties

- None.

## Outcome

Completed. Executor logs now expose live progress during Claude runs, including process PID and observed output growth, reducing "blind hang" diagnosis time.
