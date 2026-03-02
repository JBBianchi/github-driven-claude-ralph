# Task: Remove task-id PR label instruction from executor prompt

- **Issue:** —
- **Status:** completed
- **Started:** 2026-03-02T12:17:15.8748561+01:00
- **Completed:** 2026-03-02T12:21:16.2148043+01:00

## Objective

Remove the executor prompt instruction that adds `task:<task_id>` labels on PRs because runtime orchestration does not depend on those labels.

## Work performed

- Identified `task:<task_id>` usage in `prompts/exec.md`.
- Confirmed runtime PR/task linkage mechanisms use branch matching and work-mapping comments, not per-task PR labels.
- Updated `prompts/exec.md` to remove the `task:<task_id>` label instruction.
- Ran `npm run typecheck` and `npm test` (tests required escalated execution due sandbox spawn permission limits).

## Decisions made

- Replace the label instruction with guidance to keep linkage in PR body only (task issue reference), avoiding dynamic label sprawl.

## Blockers / uncertainties

- None.

## Outcome

Completed. Executor prompt no longer instructs adding dynamic per-task PR labels.
