# Task: Evaluate sub-agent refactor opportunities

- **Issue:** #— (local analysis request)
- **Status:** completed
- **Started:** 2026-03-04T14:15:55.7676626+01:00
- **Completed:** 2026-03-04T14:18:10.7262306+01:00

## Objective

Assess whether the current planner/executor orchestration would benefit from Claude sub-agents and define a practical migration path.

## Work performed

- Reviewed current Claude invocation wrapper and lifecycle controls in `src/claude.ts`.
- Reviewed planner/executor orchestration flow and prompt surfaces in `src/planner.ts`, `src/executor.ts`, and `prompts/*.md`.
- Reviewed configuration and runtime wiring in `src/config.ts`, `src/types.ts`, `docker-compose.yml`, and `scripts/entrypoint.sh`.
- Reviewed unit tests covering Claude invocation plumbing and orchestration behavior.
- Validated official Claude sub-agent capabilities from the referenced documentation.

## Decisions made

- Recommend a phased refactor that starts with prompt-only delegation inside existing `claude -p` calls.
- Defer any orchestrator-level parallel fan-out until prompt-level delegation is stable and measurable.
- Keep current deterministic state machine (claiming, labeling, merge gating) unchanged.

## Blockers / uncertainties

- Sub-agent tool allowlists and permission inheritance should be validated in the target runtime image before broad rollout.
- Throughput/latency impact is workload-dependent and needs production metrics after pilot.

## Outcome

Sub-agent adoption is feasible and likely beneficial for complex executor/planner workflows if introduced incrementally with guardrails, telemetry, and rollback toggles.
