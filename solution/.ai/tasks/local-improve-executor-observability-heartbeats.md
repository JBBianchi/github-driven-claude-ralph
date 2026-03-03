# Task: Improve executor observability with phase timing and heartbeats

- **Issue:** —
- **Status:** completed
- **Started:** 2026-03-03T14:21:22.5718946+01:00
- **Completed:** 2026-03-03T14:31:16.4450360+01:00

## Objective

Improve runtime visibility for executor operations by adding structured progress logs around long-running Claude and CI polling steps.

## Work performed

- Extended `src/types.ts` `ClaudeInvocation` with optional `logger` and `activity` fields.
- Updated `src/claude.ts` to emit lifecycle logs (`started`, `heartbeat`, `succeeded`, `failed`) through the passed logger for long-running Claude calls.
- Added 30-second Claude heartbeat cadence while invocations are active, with elapsed and timeout values.
- Updated `src/executor.ts` `pollForCIResult` to support optional logger heartbeat logs (`started`, per-poll heartbeat, `completed`, timeout).
- Added review-loop observability logs for Claude completion and CI evaluation timing per attempt.
- Added executor iteration lifecycle logs in `runExecutorIteration` with start/finish markers, outcome classification, and duration.
- Wired executor implementation and conflict-resolution Claude invocations to include logger + activity context.
- Added and updated tests in `tests/unit/claude.test.ts` and `tests/unit/executor.test.ts` for lifecycle logging and CI heartbeat logging.
- Ran required checks in order: `npm run typecheck` then `npm test` (both passing).

## Decisions made

- Added observability through existing structured logger plumbing instead of introducing new dependencies or telemetry systems.
- Kept the new logging hooks optional on Claude invocations to avoid forcing planner call-site changes.
- Focused changes on executor and shared Claude wrapper because that is where the perceived stuck behavior was observed.

## Blockers / uncertainties

- None.

## Outcome

Completed. Executor progress is now visible during long Claude and CI wait periods, with explicit iteration-level outcomes and durations.
