# AGENTS.md — GitHub-Driven Claude Agent

## Project overview

Dockerized TypeScript orchestration layer that drives Claude Code CLI in headless mode (`-p`) to autonomously plan and execute GitHub issues. Two roles share one image: **planner** (issues → plans → tasks) and **executor** (tasks → branches → PRs → merge). See `HIGH_LEVEL_PLAN.md` for full architecture.

All file paths referenced by the agent must be relative to `solution/`. Never read, write, or assume paths outside this directory. All shell commands (`npm`, `npx`, `docker`) must be run from `solution/`.

## Tech stack

- **Runtime:** Node.js 20 (ESM, `"type": "module"`)
- **Language:** TypeScript 5.4+ (`strict: true`, `NodeNext` module resolution)
- **Test framework:** Vitest 3+
- **Sole runtime dependency:** `execa` (all external tools invoked as CLI subprocesses)
- **External CLIs (available at runtime):** `git`, `gh`, `claude`, `gpg`, `ssh`
- **Container:** Multi-stage Docker build (`node:20-slim`), non-root `agent` user

## File structure

```
solution/
├── src/                  # TypeScript source (rootDir)
│   ├── index.ts          # CLI entrypoint — parses role arg, launches loop
│   ├── planner.ts        # Planner polling loop (plan + task decomposition)
│   ├── executor.ts       # Executor polling loop (claim → implement → review → merge)
│   ├── claude.ts         # Claude Code CLI invocation wrapper
│   ├── github.ts         # gh CLI wrapper (issues, PRs, labels, comments)
│   ├── git.ts            # git CLI wrapper (sync, worktree, commit, push)
│   ├── config.ts         # Env var parsing + validation
│   ├── state.ts          # Local state file management + GitHub recovery
│   ├── signing.ts        # Signing validation (entrypoint does actual import)
│   ├── logger.ts         # Structured logging with timestamps
│   ├── log-files.ts      # Log file appending utilities
│   └── types.ts          # Shared type definitions (no logic)
├── tests/
│   └── unit/             # Unit tests — one per source module
├── prompts/              # Markdown prompt files for Claude invocations
├── scripts/
│   └── entrypoint.sh     # Bash — OS-level credential plumbing only
├── Dockerfile            # Multi-stage build
├── docker-compose.yml    # Planner + executor services
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Development workflow

### Commands

```bash
npm ci                    # Install dependencies
npm run typecheck         # Type-check without emitting (tsc --noEmit)
npm run build             # Compile to dist/
npm test                  # Run all unit tests (vitest run)
```

### Docker

```bash
docker compose build                      # Build the image
docker compose up planner                 # Run planner only
docker compose up executor                # Run executor only
docker compose up                         # Run both
```

The Dockerfile uses multi-stage builds: `build` stage compiles TypeScript with devDependencies; `runtime` stage copies only `dist/` and production deps. **Never bake secrets into the image** — use Docker Compose secrets or volume mounts.

## Required pre-completion checks

Before concluding any task, always run — in order:

```bash
npm run typecheck
npm test
```

If either fails, fix the issue before producing output. Do not propose partial implementations or defer failures to a follow-up task.

## Prohibited changes

- Do not replace CLI wrappers (`execa` calls to `git`, `gh`, `claude`) with SDKs or libraries.
- Do not introduce additional runtime dependencies beyond `execa`. DevDependencies (types, test tools) are fine.
- Do not refactor modules to classes unless explicitly required by the task.
- Do not make network calls, spawn subprocesses, or touch the filesystem in unit tests. Mock everything.
- Do not modify Dockerfile layer ordering or stage structure without explicit justification.
- Do not add default exports. All exports are named.

## Coding standards

### TypeScript

- `strict: true` is non-negotiable. Never use `any`; prefer `unknown` + type narrowing.
- All imports use the `.js` extension (`import { foo } from './bar.js'`) for NodeNext compatibility.
- All exports are named. No default exports.
- Prefer `interface` for object shapes; use `type` for unions and aliases.
- Use `const` by default; `let` only when reassignment is required.
- Prefer `async`/`await` over raw Promises. Never use callbacks.

### Documentation

- Every exported function, interface, type, and constant **must** have a JSDoc comment.
- JSDoc must include `@param` and `@returns` tags for functions.
- Internal helpers may use inline comments only where the logic is non-obvious.
- Keep comments factual and terse — do not restate what the code already says.

### Error handling

- Fail fast with descriptive `Error` messages (see `config.ts` for reference).
- Never swallow errors silently. Catch only when you can handle or log meaningfully.
- CLI subprocess errors (`execa`) should include the command and stderr in the error message.

### Performance and determinism

- All polling loops must sleep a fixed, configurable interval. No adaptive/dynamic sleep.
- No unbounded retries. Every retry loop must have a hard cap (e.g., `MAX_REVIEW_ATTEMPTS = 3`).
- Backoff delays, if used, must be capped (e.g., max 5 minutes).
- No infinite promise chains. Every `async` path must terminate or throw within a bounded number of iterations.
- Timeouts on all subprocess calls. Never `await` an `execa` call without a timeout.

### Code style

- Use `function` declarations for top-level module functions (not arrow functions assigned to `const`).
- Arrow functions are fine for callbacks, closures, and inline returns.
- Prefer early returns over deeply nested conditionals.
- No classes unless the domain requires stateful instances — prefer plain functions and interfaces.

## Testing (TDD)

### Principles

1. **Write tests first.** For every new function or behavior change, write the failing test before the implementation.
2. **One test file per source module.** `src/foo.ts` → `tests/unit/foo.test.ts`.
3. **Tests must run without network or filesystem side effects.** Mock all external CLI calls (`execa`), env vars, and file I/O.
4. **Test structure:** Use `describe` blocks per function, `it` blocks per behavior. Use clear names: `it('throws when REPO_URL is missing')`.
5. **Setup/teardown:** Use `beforeEach`/`afterEach` for env or state setup. Always restore original state (see `config.test.ts` for the pattern).

### What to test

- **Config parsing:** All required vars, defaults, overrides, and validation errors.
- **CLI wrappers (`git.ts`, `github.ts`, `claude.ts`):** Verify correct args are passed to `execa`. Mock `execa` — do not call real CLIs.
- **State management:** Round-trip read/write, missing file recovery, GitHub state recovery.
- **Loop logic (`planner.ts`, `executor.ts`):** Phase transitions, error handling, sleep behavior. Mock all dependencies.
- **Edge cases:** Empty issue lists, claim conflicts, CI failure retry exhaustion, malformed JSON.

### Running tests

```bash
npm test                  # All tests
npx vitest run tests/unit/config.test.ts  # Single file
npx vitest --watch        # Watch mode during development
```

All tests must pass before any commit. The CI pipeline runs `npm run typecheck && npm test`.

## Prompt files

Files in `prompts/` are the most critical part of the project — they are the "brain" of the agents. Treat changes to prompts with the same rigor as schema migrations.

- Keep instructions concrete and actionable.
- Reference specific `gh` and `git` commands Claude should use.
- Preserve the `<!-- agent-meta ... -->` and `<!-- work-mapping ... -->` block formats exactly. Do not alter field names, ordering, or delimiters.
- Never auto-modify prompt structure (headings, step numbering, rule sections) without explicit approval.
- All prompt changes must be validated against a test repository before merging.

## Environment variables

See `.env.example` for the full list. Required: `REPO_URL`, `REPO_SLUG`, `GH_TOKEN`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`. All others have sensible defaults.

## Key design decisions

- **CLI over SDK:** Claude Code is invoked via `claude -p` to get the full agent loop (tool use, file editing, bash) for free.
- **`execa` over child_process:** Type-safe, promise-based, better error formatting.
- **Polling over webhooks:** Explicit design choice for simplicity and Docker portability.
- **GitHub as source of truth:** All durable state lives in issues/labels/PRs. Local state files are a fast-path cache, recoverable from GitHub.
- **`--append-system-prompt-file` over `--system-prompt-file`:** Preserves Claude Code's built-in tool instructions.
