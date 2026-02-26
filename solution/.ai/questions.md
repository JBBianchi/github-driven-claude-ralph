- OPEN QUESTION: How should migration from plain labels to status:* be handled for already-open tasks?
- ASSUMPTION: Planner/executor can support a short dual-read period and write only status:* labels.
- NEEDED TO RESOLVE: Decide between one-time migration script vs compatibility window in code.
- SAFE TO PROCEED?: Yes.

- OPEN QUESTION: What stale threshold should trigger waiting-blocked comments?
- ASSUMPTION: Start with fixed threshold (for example, 24h) and make configurable later if needed.
- NEEDED TO RESOLVE: Product preference on noise vs visibility.
- SAFE TO PROCEED?: Yes.
