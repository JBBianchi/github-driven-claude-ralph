# Task: Make prompt doc comments mandatory

- **Issue:** #—
- **Status:** completed
- **Started:** 2026-03-03T14:38:14.2264207+01:00
- **Completed:** 2026-03-03T14:40:25+01:00

## Objective

Update code-producing prompts so generated changes must include mandatory documentation comments in a language-appropriate format.

## Work performed

- Identified code-producing prompts: `prompts/exec.md` and `prompts/review.md`.
- Added a mandatory documentation rule to `prompts/exec.md`.
- Added a mandatory documentation rule to `prompts/review.md`.
- Revised wording from JSDoc-specific to language-agnostic documentation comments.

## Decisions made

- Scoped the requirement to prompts that directly instruct code changes.
- Used language-agnostic wording so the executor can apply it across TypeScript, Python, C#, and other languages.

## Blockers / uncertainties

- None.

## Outcome

Completed. Both code-producing prompts now require language-appropriate documentation comments for public/exported symbols, and the required checks passed.
