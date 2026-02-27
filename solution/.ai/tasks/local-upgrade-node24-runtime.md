# Task: Upgrade runtime to Node 24

- **Issue:** -
- **Status:** completed
- **Started:** 2026-02-27T11:29:08.3326065+01:00
- **Completed:** 2026-02-27T11:32:19.1826513+01:00

## Objective

Update container runtime to Node 24 and align related development dependencies with the Node 24 toolchain.

## Work performed

- Updated `Dockerfile` base image from `node:20-slim` to `node:24-slim`.
- Updated `@types/node` in `package.json` from `^20.0.0` to `^24.0.0`.
- Ran `npm install` to refresh `package-lock.json` and local dependencies.
- Ran required checks in order: `npm run typecheck`, then `npm test`.

## Decisions made

- Kept the `@types/node` range on major 24 to match the Node 24 runtime target.

## Blockers / uncertainties

- `npm test` fails in this execution environment with `spawn EPERM` while Vitest/Vite initializes. The failure is caused by child-process spawning restrictions in the host environment, not by TypeScript compilation or dependency resolution.

## Outcome

Node 24 runtime and related Node type dependency updates were applied successfully. Typecheck passed; unit tests could not be executed successfully in this environment due `spawn EPERM`.
