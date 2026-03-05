# Task: Implement Codex provider switch across planner/executor stack

- **Issue:** #— (local implementation request)
- **Status:** completed
- **Started:** 2026-03-05T12:37:57.3603781+01:00
- **Completed:** 2026-03-05T12:52:41.6189754+01:00

## Objective

Implement provider-selectable agent CLI support (`claude` or `codex`) in the existing single stack, including runtime config, container startup wiring, docs, and tests.

## Work performed

- Added provider-neutral invocation and auth primitives: `src/agent-cli.ts`, `src/agent-auth.ts`.
- Added Codex CLI adapter in `src/codex.ts` with JSONL parsing, resume support, prompt-file prepend, auth normalization, and log output.
- Updated `src/claude.ts` to use shared auth normalization (`Agent authentication failed:` prefix).
- Switched planner/executor from direct Claude wrapper calls to provider-dispatched calls in `src/planner.ts` and `src/executor.ts`.
- Added provider/model fields to config contract and env parsing in `src/types.ts` and `src/config.ts`.
- Added provider/model logging at startup in `src/index.ts`.
- Updated runtime files for provider support:
  - `Dockerfile` installs `@openai/codex` and provisions `/home/agent/.codex`.
  - `docker-compose.yml` adds provider env vars and Codex home mount.
  - `scripts/entrypoint.sh` now branches startup checks by provider (Claude vs Codex).
  - `.env.example` documents provider envs and Codex mount path.
- Updated `README.md` for provider switch model, env vars, and provider capability notes.
- Added and updated tests:
  - New: `tests/unit/codex.test.ts`, `tests/unit/agent-cli.test.ts`.
  - Updated: `tests/unit/config.test.ts`, `tests/unit/planner.test.ts`, `tests/unit/executor.test.ts`, `tests/unit/claude.test.ts`, plus config fixtures in other unit tests.
- Ran required validation gates in order: `npm run typecheck`, `npm test`.

## Decisions made

- Kept single-stack architecture with runtime provider switching (`claude` default).
- Normalized fatal auth handling across providers with one prefix (`Agent authentication failed:`) so planner/executor stop logic remains deterministic.
- Preserved Claude compatibility by keeping `claudeModel` as legacy alias mirrored from `agentModel`.
- Kept Claude sub-agent config behavior unchanged for Claude and explicitly ignored for Codex with warning logs.

## Blockers / uncertainties

- Local `bash -n` validation for `scripts/entrypoint.sh` could not run in this host due Bash access restrictions (`E_ACCESSDENIED`).

## Outcome

Completed successfully. Typecheck and full unit test suite passed with provider-switch support for both planner and executor roles.
