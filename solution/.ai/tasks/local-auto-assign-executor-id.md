# Task: Auto-assign executor IDs when EXECUTOR_ID is missing

- **Issue:** —
- **Status:** completed
- **Started:** 2026-03-03T13:09:23.2555006+01:00
- **Completed:** 2026-03-03T13:16:40.1815215+01:00

## Objective

Allow executor instances to derive distinct `executor-XX` identifiers automatically when `EXECUTOR_ID` is not provided.

## Work performed

- Added automatic executor ID resolution in `src/config.ts` when `EXECUTOR_ID` is absent for role `executor`.
- Implemented a bounded lock-protected allocator using `/workspace/state/executor/.id-allocation.lock` and per-instance mapping files in `/workspace/state/executor/.instance-ids`.
- Added support for optional `EXECUTOR_INSTANCE_KEY` (fallback to `HOSTNAME`) to keep auto-assigned IDs stable per instance key.
- Added and updated unit tests in `tests/unit/config.test.ts` for allocation, mapping reuse, and explicit ID override behavior.
- Updated `.env.example` to document optional `EXECUTOR_ID` override and automatic allocation behavior.
- Ran required checks: `npm run typecheck` then `npm test` (all passing).

## Decisions made

- Use file-based coordination in a shared state volume so multiple executor containers can self-assign unique sequential IDs without manual service duplication.
- Keep explicit `EXECUTOR_ID` as highest-priority override to preserve backward compatibility.
- Cap lock retries to avoid unbounded waits and fail fast on unrecoverable allocation errors.

## Blockers / uncertainties

- None.

## Outcome

Completed. Executors now auto-assign unique IDs (`executor-01`, `executor-02`, ...) when `EXECUTOR_ID` is not provided.
