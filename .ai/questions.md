- OPEN QUESTION: Which Claude integration is authoritative for both agents in v1?
- ASSUMPTION: Claude Code with mounted `.credentials.json`.
- NEEDED TO RESOLVE: RESOLVED 2026-02-22 (user selected Claude Code runtime).
- SAFE TO PROCEED?: YES.

- OPEN QUESTION: What is the required merge authority?
- ASSUMPTION: Executor auto-merges when checks/reviews pass.
- NEEDED TO RESOLVE: RESOLVED 2026-02-22 (user enabled auto-merge).
- SAFE TO PROCEED?: YES.

- OPEN QUESTION: What is the GPG signing policy?
- ASSUMPTION: Signing controlled by a boolean flag; if enabled and unavailable, fail fast.
- NEEDED TO RESOLVE: RESOLVED 2026-02-22 (user confirmed this behavior).
- SAFE TO PROCEED?: YES.

- OPEN QUESTION: What is the v1 executor deployment scope?
- ASSUMPTION: Single isolated executor/repo/host.
- NEEDED TO RESOLVE: RESOLVED 2026-02-22 (user selected single isolated deployment).
- SAFE TO PROCEED?: YES.

- OPEN QUESTION: How are missing labels handled?
- ASSUMPTION: Planner/executor auto-create missing labels.
- NEEDED TO RESOLVE: RESOLVED 2026-02-22 (user selected auto-create).
- SAFE TO PROCEED?: YES.
