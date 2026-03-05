# Task: Switch Codex container auth to auth-file copy with per-service local homes

- **Issue:** #— (local implementation request)
- **Status:** completed
- **Started:** 2026-03-05T13:02:22.9067100+01:00
- **Completed:** 2026-03-05T13:04:20.2589313+01:00

## Objective

Replace full host `.codex` mounting with auth-file-only mounting, while keeping planner and executor Codex homes isolated from each other.

## Work performed

- Updated `docker-compose.yml` to:
  - mount only `${CODEX_AUTH_FILE}` (default `./secrets/codex/auth.json`) read-only into `/run/secrets/codex/auth.json`.
  - assign separate persistent Codex home volumes per service: `codex_planner_home` and `codex_executor_home` at `/home/agent/.codex`.
- Updated `scripts/entrypoint.sh` Codex branch to:
  - require auth file at `/run/secrets/codex/auth.json` (override via `CODEX_AUTH_SOURCE`).
  - copy auth file into local service home (`/home/agent/.codex/auth.json`) before `codex login status`.
- Updated `.env.example` variable from `CODEX_HOME_DIR` to `CODEX_AUTH_FILE`.
- Updated `README.md` to document auth-file-only Codex mode and service-isolated Codex homes.

## Decisions made

- Keep auth source shared (single mounted `auth.json`) but keep runtime Codex state isolated per service via dedicated Docker volumes.

## Blockers / uncertainties

- None.

## Outcome

Completed successfully with required checks passing.
