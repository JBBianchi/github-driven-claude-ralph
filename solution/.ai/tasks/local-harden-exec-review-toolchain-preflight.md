# Task: Harden executor and review prompts with strict toolchain preflight

- **Issue:** #—
- **Status:** completed
- **Started:** 2026-03-03T17:49:28.4779996+01:00
- **Completed:** 2026-03-03T17:50:53.2159895+01:00

## Objective

Make prompt guidance generic but strict about installing and validating required project tools before implementation and CI-fix work.

## Work performed

- Rewrote `prompts/exec.md` to require a mandatory toolchain preflight, explicit install rules, and timeout-based command discipline.
- Rewrote `prompts/review.md` to mirror mandatory toolchain preflight and timeout-based command discipline for CI troubleshooting.

## Decisions made

- Enforced tooling checks as a required workflow phase before code changes.
- Kept instructions generic across languages and ecosystems by deriving required tools from task commands and repository manifests.
- Added strict stop/report behavior when tool installation or verification fails.

## Blockers / uncertainties

- None.

## Outcome

Prompt hardening is implemented in both executor and review prompts, and required validation checks passed.
