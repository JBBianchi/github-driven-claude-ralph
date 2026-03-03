# Task: Fix executor claim livelock and ownership drift

- **Issue:** —
- **Status:** completed
- **Started:** 2026-03-03T12:45:14.9065716+01:00
- **Completed:** 2026-03-03T12:57:48.3550275+01:00

## Objective

Implement deterministic task-claim arbitration so multiple executors do not livelock or reopen contested tasks.

## Work performed

- Reworked claim arbitration in `src/github.ts` to elect winner by latest claim comment and perform explicit winner finalize / loser cleanup transitions.
- Added claim-specific helpers for label parsing, snapshot reads, and claim logging to make transitions idempotent and observable.
- Extended `ClaimAttempt` in `src/types.ts` with `reason` and `ownerExecutorId` diagnostics.
- Hardened runnable task selection in `src/executor.ts` by skipping `status:todo` tasks already carrying `claimed-by:*` labels and logging skipped task IDs.
- Updated executor claim-failure logging in `src/executor.ts` to include structured failure reason and current owner.
- Fixed executor identity environment variable for `executor2` in `docker-compose.yml` to use `EXECUTOR2_ID`.
- Updated `.env.example` with `EXECUTOR2_ID` template entry.
- Added/updated unit tests in `tests/unit/github.test.ts` and `tests/unit/executor.test.ts` for claim arbitration and runnable-task filtering behavior.
- Ran required checks: `npm run typecheck` then `npm test` (all passing).

## Decisions made

- Keep nonce-based claim protocol and label-based ownership model, but make arbitration asymmetric and cleanup claim-safe.

## Blockers / uncertainties

- None.

## Outcome

Implemented and verified. Claim coordination no longer uses the symmetric "both lose" path, and executor task selection now ignores already-claimed todo tasks.
