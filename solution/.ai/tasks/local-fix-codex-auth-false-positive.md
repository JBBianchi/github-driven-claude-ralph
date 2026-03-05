# Task: Fix Codex auth false-positive detection during long-running exec

- **Issue:** #— (local runtime diagnosis)
- **Status:** completed
- **Started:** 2026-03-05T13:19:04.0432692+01:00
- **Completed:** 2026-03-05T13:20:17.5718055+01:00

## Objective

Prevent false fatal auth shutdowns when Codex emits non-auth runtime errors, while preserving hard-stop behavior for real auth failures.

## Work performed

- Confirmed from `logs/entrypoint-executor.log` that startup auth is valid:
  - `codex login status` passes (`Logged in using ChatGPT`)
  - codex health check returns successful `thread.started` + `ok` response.
- Narrowed Codex auth failure detection in `src/agent-auth.ts`:
  - removed over-broad triggers (`401`, `openai_api_key`)
  - kept definitive signals (`not logged in`, `login required`, invalid/incorrect api key, explicit codex/openai auth-failed contexts).
- Improved Codex auth-failure diagnostics in `src/codex.ts`:
  - added `throwIfCodexAuthFailureWithLog` wrapper to append raw output context to `codex.log` when auth is detected.
- Added regression coverage in `tests/unit/codex.test.ts`:
  - verifies generic runtime `401` reconnect errors do not trigger fatal auth exceptions.

## Decisions made

- Treat only explicit, high-confidence Codex auth strings as fatal to avoid crashing executor/planner on transient transport/runtime issues.

## Blockers / uncertainties

- Exact prior failing event payload was not fully retained in old logs due early auth throw; new logging now captures it.

## Outcome

Completed. Required checks passed (`npm run typecheck`, `npm test`).
