import type { ClaudeSubagentMap, Role } from './types.js';

function createPlannerSubagents(): ClaudeSubagentMap {
  return {
    'planner-codebase-analyst': {
      description: 'Analyzes repository areas and returns concrete findings with file references.',
      prompt: [
        'You are the planner codebase analyst.',
        'Read the repository and return concise findings with exact file paths.',
        'Do not create or edit GitHub issues directly.',
      ].join(' '),
    },
    'planner-plan-author': {
      description: 'Drafts implementation plans from feature requirements and analysis.',
      prompt: [
        'You are the planner plan author.',
        'Produce actionable implementation plans with concrete steps and affected files.',
        'Avoid vague recommendations.',
      ].join(' '),
    },
    'planner-task-decomposer': {
      description: 'Decomposes approved plans into independent, dependency-aware tasks.',
      prompt: [
        'You are the planner task decomposer.',
        'Create minimal, dependency-aware task breakdowns with explicit acceptance criteria.',
        'Prefer independently executable tasks.',
      ].join(' '),
    },
  };
}

function createExecutorSubagents(): ClaudeSubagentMap {
  return {
    'executor-implementer': {
      description: 'Implements task-scoped code changes with minimal unrelated edits.',
      prompt: [
        'You are the executor implementer.',
        'Make focused code changes for the task scope only and keep diffs minimal.',
        'Run required local validation before concluding work.',
      ].join(' '),
    },
    'executor-ci-debugger': {
      description: 'Diagnoses failing CI checks and proposes the smallest safe fix.',
      prompt: [
        'You are the executor CI debugger.',
        'Identify root cause from failing checks and apply the smallest safe fix.',
        'Do not introduce feature work while fixing CI.',
      ].join(' '),
    },
    'executor-conflict-resolver': {
      description: 'Resolves git merge conflicts while preserving task intent and base-branch correctness.',
      prompt: [
        'You are the executor merge conflict resolver.',
        'Resolve conflict markers carefully and preserve intended behavior.',
        'Prioritize correctness and build stability over large rewrites.',
      ].join(' '),
    },
  };
}

/**
 * Builds a role-specific Claude sub-agent map when enabled.
 *
 * @param role - Agent role driving the current invocation.
 * @param enabled - Whether sub-agents are enabled via configuration.
 * @returns Named sub-agent definitions, or `undefined` when disabled.
 */
export function getClaudeSubagents(
  role: Role,
  enabled: boolean,
): ClaudeSubagentMap | undefined {
  if (!enabled) {
    return undefined;
  }

  return role === 'planner'
    ? createPlannerSubagents()
    : createExecutorSubagents();
}
