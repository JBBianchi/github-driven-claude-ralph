# Task: Upgrade GitHub CLI install and review gating

- **Issue:** —
- **Status:** completed
- **Started:** 2026-02-26T18:50:15+01:00
- **Completed:** 2026-02-26T18:53:34+01:00

## Objective

Update the runtime to use an up-to-date GitHub CLI source and make PR review handling robust when Copilot reviewer assignment fails.

## Work performed

- Investigated current `gh` installation path and executor PR flow/log failures.
- Switched Docker image to install `gh` from GitHub's official apt repository instead of Debian's package.
- Added `gh` version startup logging in `scripts/entrypoint.sh`.
- Updated Copilot review request to use `gh api` pull-request reviewer endpoint (REST) and handle already-requested responses.
- Updated PR status evaluation to require approved review before returning `mergeable`.
- Updated and expanded unit tests for reviewer request and PR status behavior.
- Ran `npm run typecheck` and `npm test` successfully.

## Decisions made

- Used REST API (`gh api`) for reviewer assignment to avoid the GraphQL `projectCards` code path that fails in current logs.
- Treated non-approved review decisions as pending to prevent immediate merge after PR creation.

## Blockers / uncertainties

- None currently.

## Outcome

Completed. Runtime now installs a current `gh` source and executor no longer merges PRs without approved review.
