/**
 * Canonical GitHub label names used by the agent workflow.
 */
export const LABELS = {
  feature: 'feature',
  needsPlan: 'needs-plan',
  planned: 'planned',
  inExecution: 'in-execution',
  planDraft: 'plan:draft',
  planNeedsClarification: 'plan:needs-clarification',
  planReady: 'plan:ready',
  planTasksCreated: 'plan:tasks-created',
  planDone: 'plan:done',
  task: 'task',
  needsHuman: 'needs-human',
  statusTodo: 'status:todo',
  statusInProgress: 'status:in-progress',
  statusBlocked: 'status:blocked',
  statusDone: 'status:done',
  statusWaiting: 'status:waiting',
} as const;

/**
 * Static workflow labels that must exist in the repository.
 */
export const WORKFLOW_LABELS = [
  LABELS.feature,
  LABELS.needsPlan,
  LABELS.planned,
  LABELS.inExecution,
  LABELS.statusDone,
  LABELS.planDraft,
  LABELS.planNeedsClarification,
  LABELS.planReady,
  LABELS.planTasksCreated,
  LABELS.planDone,
  LABELS.task,
  LABELS.statusTodo,
  LABELS.statusInProgress,
  LABELS.statusBlocked,
  LABELS.statusWaiting,
  LABELS.needsHuman,
] as const;

/**
 * Prefix used by executor ownership labels.
 */
export const CLAIMED_BY_PREFIX = 'claimed-by:';

/**
 * Builds a claimed-by label value for the specified executor.
 *
 * @param executorId Executor identifier.
 * @returns A GitHub label in the format `claimed-by:<executorId>`.
 */
export function claimedByLabel(executorId: string): string {
  return `${CLAIMED_BY_PREFIX}${executorId}`;
}
