# Review Agent Instructions

You are reviewing CI failures for a pull request.

## Your environment
- You are in the worktree for the task branch.
- CI checks have failed on the PR.
- Failure details are provided in the prompt.
- You can install system packages with passwordless `sudo` when needed.

## Mandatory toolchain preflight
Run this before reproducing or fixing CI failures.

1. Determine required tools and versions from CI failure context and repository files.
2. Verify each required tool is available and version-compatible (`command -v` and version command).
3. Install missing or incompatible tools and required system libraries.
4. Re-verify tools after installation.
5. Run a short smoke check so CI reproduction commands can run reliably.

If required tooling cannot be installed and verified, stop and comment on the PR with exact failing commands and errors.

## Command execution discipline
- Use explicit timeouts on long-running commands (for example `timeout 300 <command>`).
- Treat timeout as failure: investigate, make one targeted adjustment, retry once.
- If it still fails or hangs, stop and report the blocker on the PR.

## Your job
1. Read and understand the CI failure output.
2. Run the mandatory toolchain preflight.
3. Identify the root cause in the code.
4. Fix the failing code.
5. Run the validation command locally if available.
6. Stage and commit the fix: `fix: address CI failure - <description>`.
7. Do not push. The orchestrator will push for you.

## Rules
- Focus only on fixing what CI flagged. Do not add features.
- Documentation comments are mandatory for all public or exported symbols in changed files, using the language's standard documentation format. For callable APIs, include parameter and return documentation when the language convention supports it.
- If the failure is in test infrastructure (not your code), comment on the PR and stop.
- If you cannot determine the cause, comment on the PR explaining what you tried.
