import {
  syncRepo,
  ensureWorktree,
  pushBranch,
  deleteRemoteBranch,
  makeBranchName,
  mergeBase,
  abortMerge,
} from './git.js';
import {
  listIssues,
  claimTask,
  findPRByBranch,
  getPRStatus,
  getPRCheckDetails,
  mergePR,
  editIssueLabels,
  closeIssue,
  postWorkMapping,
  addComment,
  requestCopilotReview,
} from './github.js';
import { invokeClaude } from './claude.js';
import { getClaudeSubagents } from './subagents.js';
import {
  readExecutorState,
  writeExecutorState,
  clearActiveTask,
  recoverStateFromGitHub,
} from './state.js';
import { CLAIMED_BY_PREFIX, LABELS, claimedByLabel } from './labels.js';
import type {
  Config,
  Logger,
  GitHubIssue,
  GitHubPR,
  ExecutorState,
  PRStatus,
  ClaudeSubagentMap,
} from './types.js';

const PROMPTS_DIR = '/opt/agent/prompts';
const MAX_REVIEW_ATTEMPTS = 3;
const MAX_CONSECUTIVE_FAILURES = 3;
const CLAUDE_AUTH_FAILURE_PREFIX = 'Claude authentication failed:';

async function listRunnableTasks(config: Config, logger: Logger): Promise<GitHubIssue[]> {
  const tasks = await listIssues(config, [LABELS.task, LABELS.statusTodo]);
  const skipped = tasks.filter((task) => task.labels.some((label) => label.startsWith(CLAIMED_BY_PREFIX)));
  if (skipped.length > 0) {
    logger.warn('Skipping todo tasks with ownership labels', {
      taskIds: skipped.map((task) => task.number),
      claimLabels: skipped.map((task) => ({
        taskId: task.number,
        labels: task.labels.filter((label) => label.startsWith(CLAIMED_BY_PREFIX)),
      })),
    });
  }

  return tasks.filter((task) => task.labels.every((label) => !label.startsWith(CLAIMED_BY_PREFIX)));
}

function isFatalClaudeAuthError(error: unknown): boolean {
  return String(error).includes(CLAUDE_AUTH_FAILURE_PREFIX);
}

export function buildExecutorPrompt(
  config: Config,
  task: GitHubIssue,
  branch: string,
  worktreePath: string,
): string {
  const validation = config.validationCommand
    ? `Validation command: ${config.validationCommand}`
    : 'No validation command configured.';

  return `You are the Executor agent for repository ${config.repoSlug}.
Working directory: ${worktreePath} (branch: ${branch})
Task issue: #${task.number} — ${task.title}

Task description:
${task.body}

${validation}

Implement the changes described in this task.`;
}

export function buildReviewPrompt(
  config: Config,
  task: GitHubIssue,
  pr: GitHubPR,
  checkDetails: string,
): string {
  return `You are the Executor agent reviewing CI failures for repository ${config.repoSlug}.
Task: #${task.number} — ${task.title}
PR: #${pr.number}

The following CI checks have failed:
${checkDetails}

Diagnose the failures and fix the code.`;
}

export function buildConflictPrompt(
  config: Config,
  task: GitHubIssue,
  pr: GitHubPR,
  worktreePath: string,
): string {
  return `You are the Executor agent resolving merge conflicts for repository ${config.repoSlug}.
Working directory: ${worktreePath}
Task: #${task.number} — ${task.title}
PR: #${pr.number}

The base branch (${config.baseBranch}) has diverged from this feature branch, causing merge conflicts.
A merge of origin/${config.baseBranch} has been started but has unresolved conflicts.

Resolve all merge conflicts:
1. Find all files with conflict markers (<<<<<<< , =======, >>>>>>>)
2. Resolve each conflict by choosing the correct code or combining changes appropriately
3. Stage resolved files with \`git add\`
4. Complete the merge with \`git commit --no-edit\`

Do NOT push — the orchestrator handles pushing.
Do NOT modify workflow labels.`;
}

export async function pollForCIResult(
  config: Config,
  prNumber: number,
  timeoutMs: number,
  pollIntervalMs = 30_000,
  logger?: Logger,
): Promise<PRStatus> {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  logger?.info('CI poll started', { prNumber, timeoutMs, pollIntervalMs });

  while (Date.now() < deadline) {
    const status = await getPRStatus(config, prNumber);
    const elapsedMs = Date.now() - startedAt;
    const remainingMs = Math.max(0, deadline - Date.now());
    logger?.info('CI poll heartbeat', { prNumber, status, elapsedMs, remainingMs });
    if (status !== 'pending') {
      logger?.info('CI poll completed', { prNumber, status, elapsedMs });
      return status;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  logger?.warn('CI poll timed out', { prNumber, timeoutMs, elapsedMs: Date.now() - startedAt });
  return 'pending';
}

async function runReviewLoop(
  config: Config,
  logger: Logger,
  task: GitHubIssue,
  pr: GitHubPR,
  worktreePath: string,
  agents?: ClaudeSubagentMap,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_REVIEW_ATTEMPTS; attempt++) {
    logger.info('Review attempt', { attempt: attempt + 1, maxAttempts: MAX_REVIEW_ATTEMPTS });
    const attemptStartedAt = Date.now();

    const checkDetails = await getPRCheckDetails(config, pr.number);
    const prompt = buildReviewPrompt(config, task, pr, checkDetails);

    const reviewResult = await invokeClaude({
      prompt,
      systemPromptFile: `${PROMPTS_DIR}/review.md`,
      maxTurns: config.maxTurnsPerRun,
      outputFormat: 'text',
      workingDirectory: worktreePath,
      model: config.claudeModel,
      agents,
      logger,
      activity: 'executor-review',
    });
    logger.info('Review attempt Claude finished', {
      attempt: attempt + 1,
      taskId: task.number,
      prNumber: pr.number,
      success: reviewResult.success,
      claudeDurationMs: reviewResult.durationMs,
      attemptDurationMs: Date.now() - attemptStartedAt,
    });
    if (!reviewResult.success) {
      logger.warn('Claude review invocation failed; deferring to next iteration', {
        taskId: task.number,
        prNumber: pr.number,
      });
      return false;
    }

    await pushBranch(worktreePath);

    const newStatus = await pollForCIResult(config, pr.number, 10 * 60 * 1000, 30_000, logger);
    logger.info('Review attempt CI evaluation finished', {
      attempt: attempt + 1,
      taskId: task.number,
      prNumber: pr.number,
      status: newStatus,
      attemptDurationMs: Date.now() - attemptStartedAt,
    });

    if (newStatus === 'mergeable') return true;
    if (newStatus !== 'failing') return false;
  }

  // Exhausted attempts — mark as blocked
  await addComment(
    config,
    task.number,
    `CI failures could not be resolved after ${MAX_REVIEW_ATTEMPTS} review attempts. Marking as blocked.`,
  );
  await editIssueLabels(
    config,
    task.number,
    [LABELS.statusBlocked],
    [LABELS.statusInProgress],
  );
  return false;
}

async function deleteMergedPRRemoteBranch(logger: Logger, branch: string): Promise<void> {
  try {
    await deleteRemoteBranch(branch);
  } catch (error: unknown) {
    logger.warn('Failed to delete remote branch after PR merge', {
      branch,
      error: String(error),
    });
  }
}

export async function runExecutorIteration(config: Config, logger: Logger): Promise<void> {
  const iterationStartedAt = Date.now();
  const claudeSubagents = getClaudeSubagents(config.role, config.claudeSubagentsEnabled);
  let outcome = 'completed';
  logger.info('Executor iteration started', { executorId: config.executorId });

  try {
    await syncRepo(config);
  } catch (error) {
    outcome = 'sync-failed';
    logger.error('Failed to sync repo', { error: String(error) });
    return;
  }

  // --- Phase 0: Recovery / Resume ---
  let state: ExecutorState;
  try {
    const localState = readExecutorState(config.executorId);
    if (localState) {
      state = localState;
    } else {
      state = await recoverStateFromGitHub(config);
      if (state.activeTaskId) {
        writeExecutorState(config.executorId, state);
        logger.info('Recovered active task from GitHub', { taskId: state.activeTaskId });
      }
    }
  } catch (error) {
    outcome = 'recovery-failed';
    logger.error('Recovery failed', { error: String(error) });
    return;
  }

  try {
    // --- Phase 1: Claim if idle ---
    if (state.activeTaskId === null) {
      const tasks = await listRunnableTasks(config, logger);
      if (tasks.length === 0) {
        outcome = 'idle-no-tasks';
        logger.info('No tasks available. Sleeping.', {});
        return;
      }

      const oldestTask = tasks.reduce((oldest, current) => (
        current.number < oldest.number ? current : oldest
      ));
      const claim = await claimTask(config, oldestTask.number);
      if (!claim.success) {
        outcome = 'claim-failed';
        logger.warn('Claim failed', {
          taskId: oldestTask.number,
          reason: claim.reason ?? 'unknown',
          ownerExecutorId: claim.ownerExecutorId ?? null,
        });
        return;
      }

      state = { activeTaskId: claim.taskId, sessionId: null, consecutiveFailures: 0 };
      writeExecutorState(config.executorId, state);
      logger.info('Claimed task', { taskId: claim.taskId });
    }

    // --- Phase 2: Setup worktree ---
    const taskIssues = await listIssues(config, [LABELS.task]);
    const task = taskIssues.find((t) => t.number === state.activeTaskId);
    if (!task) {
      outcome = 'stale-task-cleared';
      logger.warn('Active task issue not found among open tasks; clearing stale state', {
        taskId: state.activeTaskId,
      });
      clearActiveTask(config.executorId);
      return;
    }

    const branch = makeBranchName(state.activeTaskId!, task.title);
    const worktreePath = await ensureWorktree(config, state.activeTaskId!, branch);
    await postWorkMapping(config, state.activeTaskId!, branch, worktreePath);

    // --- Phase 3: Implementation ---
    logger.info('Implementation phase started', {
      taskId: task.number,
      branch,
      worktreePath,
    });
    const implementationStartedAt = Date.now();
    const prompt = buildExecutorPrompt(config, task, branch, worktreePath);
    const result = await invokeClaude({
      prompt,
      systemPromptFile: `${PROMPTS_DIR}/exec.md`,
      maxTurns: config.maxTurnsPerRun,
      outputFormat: 'json',
      workingDirectory: worktreePath,
      model: config.claudeModel,
      agents: claudeSubagents,
      resumeSessionId: state.sessionId ?? undefined,
      logger,
      activity: 'executor-implementation',
    });
    logger.info('Implementation phase finished', {
      taskId: task.number,
      success: result.success,
      claudeDurationMs: result.durationMs,
      durationMs: Date.now() - implementationStartedAt,
    });
    if (!result.success) {
      outcome = 'implementation-failed';
      logger.warn('Claude implementation invocation failed; deferring to next iteration', {
        taskId: state.activeTaskId,
      });
      return;
    }

    if (result.sessionId) {
      state.sessionId = result.sessionId;
      writeExecutorState(config.executorId, state);
    }

    // --- Phase 4: PR monitoring ---
    const pr = await findPRByBranch(config, branch);
    if (!pr) {
      outcome = 'awaiting-pr';
      logger.info('No PR yet, will continue next iteration', { branch });
      // Successful iteration - reset failure counter
      if ((state.consecutiveFailures ?? 0) > 0) {
        state.consecutiveFailures = 0;
        writeExecutorState(config.executorId, state);
      }
      return;
    }

    await postWorkMapping(config, state.activeTaskId!, branch, worktreePath, pr.number);
    const reviewRequested = await requestCopilotReview(config, pr.number);
    if (!reviewRequested) {
      logger.warn('Copilot review request unavailable for PR', { prNumber: pr.number });
    }
    const prStatus = await getPRStatus(config, pr.number);

    switch (prStatus) {
      case 'mergeable':
        await mergePR(config, pr.number);
        await deleteMergedPRRemoteBranch(logger, branch);
        await editIssueLabels(
          config,
          state.activeTaskId!,
          [LABELS.statusDone],
          [LABELS.statusInProgress, claimedByLabel(config.executorId)],
        );
        await closeIssue(config, state.activeTaskId!);
        clearActiveTask(config.executorId);
        outcome = 'merged';
        logger.info('Task complete - PR merged', { taskId: state.activeTaskId, prNumber: pr.number });
        break;

      case 'failing': {
        // --- Phase 5: Review loop ---
        const fixed = await runReviewLoop(config, logger, task, pr, worktreePath, claudeSubagents);
        if (fixed) {
          await mergePR(config, pr.number);
          await deleteMergedPRRemoteBranch(logger, branch);
          await editIssueLabels(
            config,
            state.activeTaskId!,
            [LABELS.statusDone],
            [LABELS.statusInProgress, claimedByLabel(config.executorId)],
          );
          await closeIssue(config, state.activeTaskId!);
          clearActiveTask(config.executorId);
          outcome = 'merged-after-review';
          logger.info('Task complete after review - PR merged', { taskId: state.activeTaskId, prNumber: pr.number });
        }
        break;
      }

      case 'pending':
        outcome = 'checks-pending';
        logger.info('Checks pending, will re-check next iteration', { prNumber: pr.number });
        break;

      case 'conflicting': {
        logger.info('Merge conflicts detected, attempting resolution', { prNumber: pr.number });

        const mergeClean = await mergeBase(config, worktreePath);
        if (!mergeClean) {
          const conflictPrompt = buildConflictPrompt(config, task, pr, worktreePath);
          const resolveResult = await invokeClaude({
            prompt: conflictPrompt,
            systemPromptFile: `${PROMPTS_DIR}/exec.md`,
            maxTurns: config.maxTurnsPerRun,
            outputFormat: 'text',
            workingDirectory: worktreePath,
            model: config.claudeModel,
            agents: claudeSubagents,
            logger,
            activity: 'executor-conflict-resolution',
          });
          if (!resolveResult.success) {
            outcome = 'conflict-resolution-failed';
            logger.warn('Claude conflict resolution failed; aborting merge', {
              taskId: task.number,
              prNumber: pr.number,
            });
            await abortMerge(worktreePath);
            break;
          }
        }

        await pushBranch(worktreePath);
        logger.info('Conflicts resolved, branch pushed', { prNumber: pr.number });

        const postConflictStatus = await pollForCIResult(config, pr.number, 10 * 60 * 1000, 30_000, logger);
        if (postConflictStatus === 'mergeable') {
          await mergePR(config, pr.number);
          await deleteMergedPRRemoteBranch(logger, branch);
          await editIssueLabels(
            config,
            state.activeTaskId!,
            [LABELS.statusDone],
            [LABELS.statusInProgress, claimedByLabel(config.executorId)],
          );
          await closeIssue(config, state.activeTaskId!);
          clearActiveTask(config.executorId);
          outcome = 'merged-after-conflict';
          logger.info('Task complete after conflict resolution - PR merged', {
            taskId: state.activeTaskId,
            prNumber: pr.number,
          });
        } else if (postConflictStatus === 'failing') {
          const fixed = await runReviewLoop(config, logger, task, pr, worktreePath, claudeSubagents);
          if (fixed) {
            await mergePR(config, pr.number);
            await deleteMergedPRRemoteBranch(logger, branch);
            await editIssueLabels(
              config,
              state.activeTaskId!,
              [LABELS.statusDone],
              [LABELS.statusInProgress, claimedByLabel(config.executorId)],
            );
            await closeIssue(config, state.activeTaskId!);
            clearActiveTask(config.executorId);
            outcome = 'merged-after-conflict-review';
            logger.info('Task complete after conflict resolution + review - PR merged', {
              taskId: state.activeTaskId,
              prNumber: pr.number,
            });
          }
        }
        break;
      }
    }

    // Successful iteration - reset failure counter
    if ((state.consecutiveFailures ?? 0) > 0) {
      state.consecutiveFailures = 0;
      writeExecutorState(config.executorId, state);
    }
  } catch (error) {
    if (isFatalClaudeAuthError(error)) {
      outcome = 'fatal-auth-error';
      logger.error('Fatal Claude authentication failure. Stopping executor loop.', { error: String(error) });
      throw error;
    }

    outcome = 'iteration-error';
    logger.error('Executor iteration failed', { error: String(error) });

    // Circuit breaker: track consecutive failures for active tasks
    if (state.activeTaskId !== null) {
      state.consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
      writeExecutorState(config.executorId, state);

      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        outcome = 'circuit-breaker-blocked';
        logger.warn('Circuit breaker: task failed 3 consecutive iterations, marking blocked', {
          taskId: state.activeTaskId,
          consecutiveFailures: state.consecutiveFailures,
        });
        try {
          await addComment(
            config,
            state.activeTaskId,
            `Task has failed ${MAX_CONSECUTIVE_FAILURES} consecutive iterations. Marking as blocked.`,
          );
          await editIssueLabels(
            config,
            state.activeTaskId,
            [LABELS.statusBlocked],
            [LABELS.statusInProgress],
          );
          clearActiveTask(config.executorId);
        } catch (blockError) {
          logger.error('Failed to mark task as blocked', { error: String(blockError) });
        }
      }
    }
  } finally {
    logger.info('Executor iteration finished', {
      executorId: config.executorId,
      outcome,
      durationMs: Date.now() - iterationStartedAt,
    });
  }
}

export async function runExecutorLoop(
  config: Config,
  logger: Logger,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  logger.info('Executor loop starting', { executorId: config.executorId, pollInterval: config.pollIntervalSeconds });

  while (shouldContinue()) {
    await runExecutorIteration(config, logger);
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalSeconds * 1000));
  }

  logger.info('Executor loop shutting down gracefully', {});
}

