# Task: Update Copilot reviewer handle to github-copilot

- **Issue:** #—
- **Status:** completed
- **Started:** 2026-02-26T16:58:10.9470310+01:00
- **Completed:** 2026-02-26T16:59:03.4595056+01:00

## Objective

Update the PR reviewer handle used by the executor from copilot to github-copilot and align tests and references.

## Work performed

- Updated requestCopilotReview reviewer argument from copilot to github-copilot in src/github.ts.
- Updated unit test expectation and test description in tests/unit/github.test.ts.
- Verified no remaining reviewer-handle literal references requiring code changes.
- Ran required checks in order: npm run typecheck, npm test.

## Decisions made

- Kept function and interface names unchanged (requestCopilotReview) to avoid unrelated API churn.

## Blockers / uncertainties

- None.

## Outcome

Executor now requests reviewer github-copilot; all tests and type checks pass.
