- DECISION: Use hybrid dependency model: depends_on metadata as source of truth plus waiting label as derived cache.
- DATE: 2026-02-26
- RATIONALE: Keeps executor simple while making dependencies explicit and auditable in issue body.
- ALTERNATIVES: Executor-side dependency checks; wave-only ordering; single-task feature locks.
- CONSEQUENCES: Planner must run reliable readiness sweep and own scheduling transitions.

- DECISION: Migrate workflow state labels to status:* namespace.
- DATE: 2026-02-26
- RATIONALE: Improves consistency and avoids ambiguous standalone labels as the workflow expands.
- ALTERNATIVES: Keep plain labels with a new plain waiting label.
- CONSEQUENCES: Requires coordinated update across label creation, list queries, edits, and tests.

- DECISION: Define task completion strictly by status:done label.
- DATE: 2026-02-26
- RATIONALE: Matches current label-driven lifecycle and avoids PR-state coupling in dependency resolution.
- ALTERNATIVES: Closed issue state; merged PR state; mixed heuristics.
- CONSEQUENCES: Planner sweep logic remains simple but depends on label integrity.

- DECISION: Add stale waiting guard with planner comment including blocking task IDs.
- DATE: 2026-02-26
- RATIONALE: Surfaces scheduling stalls early and improves debuggability.
- ALTERNATIVES: Silent waiting; logs only.
- CONSEQUENCES: Planner needs threshold tracking and deduped comments.
