# Task: Define planner-owned dependency scheduling plan

- **Issue:** #—
- **Status:** completed
- **Started:** 2026-02-26T17:35:10+01:00
- **Completed:** 2026-02-26T17:37:30+01:00

## Objective

Consolidate decisions on task dependency management into a concrete, implementation-ready plan without changing runtime behavior yet.

## Work performed

- Captured constraints, assumptions, milestones, and validation strategy in `.ai/` scratchpad files.
- Consolidated agreed architecture: depends_on metadata as source of truth, planner-owned waiting/todo scheduling, executor remains dependency-agnostic.
- Recorded migration intent to `status:*` labels and stale waiting guard requirement.

## Decisions made

- Use hybrid model: metadata dependencies plus derived waiting label.
- Keep completion semantics label-based using `status:done`.
- Keep executor logic simple and unchanged for dependency handling.

## Blockers / uncertainties

- Final migration approach for existing plain labels (dual-read window vs one-time migration pass).
- Threshold and dedupe policy for stale waiting comments.

## Outcome

Planning decisions are documented and ready for implementation sequencing.
