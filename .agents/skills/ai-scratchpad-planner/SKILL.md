---
name: ai-scratchpad-planner
description: "Enforce a two-phase scratchpad workflow in `.ai/` before producing a final specification. Use when the user asks for a plan, specification, design, architecture, roadmap, or similar deliverable that benefits from explicit decisions, open questions, curated context, and minimal rehydration."
---

# AI Scratchpad Planner

Use a `.ai/` scratchpad to separate planning artifacts from final deliverables.

## Objective

Follow a two-phase workflow:

1. Working phase: capture status, context, plan, decisions, questions, and rehydration notes.
2. Final phase: produce a clean, implementable deliverable only after planning artifacts are coherent.

Keep active context small, keep reasoning auditable, and keep final output free of raw working notes.

## Directory Contract

Store all scratchpad artifacts under `.ai/`.

```text
.ai/
|-- status.md
|-- context.md
|-- plan.md
|-- decisions.md
|-- questions.md
`-- rehydrate.md
```

Optional files:

```text
.ai/research.md
.ai/risk.md
.ai/glossary.md
```

### Required File Templates

#### `.ai/status.md`

- GOAL:
- CURRENT FOCUS:
- NEXT ACTIONS:
- OUT OF SCOPE:
- BLOCKED BY:
- LAST UPDATED: YYYY-MM-DD

#### `.ai/context.md`

- KEY CONSTRAINTS:
- KEY ASSUMPTIONS:
- RELEVANT PATHS / LINKS:

#### `.ai/plan.md`

- MILESTONES:
- TASK BREAKDOWN:
- VALIDATION STRATEGY:

#### `.ai/decisions.md`

Log each decision with:

- DECISION:
- DATE:
- RATIONALE:
- ALTERNATIVES:
- CONSEQUENCES:

#### `.ai/questions.md`

- OPEN QUESTION:
- ASSUMPTION:
- NEEDED TO RESOLVE:
- SAFE TO PROCEED?

#### `.ai/rehydrate.md`

- DATE:
- WHY REHYDRATE:
- SOURCES CONSULTED:
- EXTRACTED SUMMARY:
- CONTEXT UPDATED:

## Operating Procedure

### Phase 1: Build Scratchpad

1. Create `.ai/` and required files when missing.
2. Update `.ai/status.md` with goal, focus, next actions, out-of-scope items, and blockers.
3. Record unknowns in `.ai/questions.md`.
4. Curate only essential facts in `.ai/context.md`.
5. Update milestones and tasks in `.ai/plan.md`.
6. Log decisions in `.ai/decisions.md`.
7. Use `.ai/rehydrate.md` only for explicit, minimal rehydration events.

Do not produce the final specification in phase 1.

### Phase 2: Produce Final Deliverable

Start phase 2 only when planning artifacts are coherent and actionable.

1. Generate the final document at the requested path.
2. Include at least:
- Goals and non-goals
- Requirements
- Architecture or approach
- Milestones
- Risks and mitigations
- Validation and test strategy
3. Update `.ai/status.md` to record completion status and remaining work.

## Rehydration Protocol

Use rehydration as an explicit process:

1. Record why rehydration is needed in `.ai/rehydrate.md`.
2. Read only the minimum sections needed to continue.
3. Summarize findings in `.ai/rehydrate.md`.
4. Promote evergreen facts into `.ai/context.md`.
5. Continue execution from updated status and context.

## Edge Cases

- If the user explicitly opts out of `.ai/`, record the override in `.ai/status.md` and continue.
- If a decision changes, add a new entry in `.ai/decisions.md` and reference the superseded decision.
- If `.ai/context.md` becomes stale, prune stale facts and keep only active constraints and assumptions.

## Quality Bar

- Keep entries short and scannable.
- Date all decision, question, and rehydration entries.
- Prefer summaries over copy-pasted logs.
- Keep final deliverables polished and implementation-ready.
