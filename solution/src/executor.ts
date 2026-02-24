import { syncRepo, ensureWorktree, pushBranch, makeBranchName } from './git.js';
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
} from './github.js';
import { invokeClaude } from './claude.js';
import {
  readExecutorState,
  writeExecutorState,
  clearActiveTask,
  recoverStateFromGitHub,
} from './state.js';
import type { Config, Logger, GitHubIssue, GitHubPR, ExecutorState, PRStatus } from './types.js';

const PROMPTS_DIR = '/opt/agent/prompts';
const MAX_REVIEW_ATTEMPTS = 3;
const MAX_CONSECUTIVE_FAILURES = 3;

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

export async function pollForCIResult(
  config: Config,
  prNumber: number,
  timeoutMs: number,
  pollIntervalMs = 30_000,
): Promise<PRStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getPRStatus(config, prNumber);
    if (status !== 'pending') return status;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return 'pending';
}

async function runReviewLoop(
  config: Config,
  logger: Logger,
  task: GitHubIssue,
  pr: GitHubPR,
  worktreePath: string,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_REVIEW_ATTEMPTS; attempt++) {
    logger.info('Review attempt', { attempt: attempt + 1, maxAttempts: MAX_REVIEW_ATTEMPTS });

    const checkDetails = await getPRCheckDetails(config, pr.number);
    const prompt = buildReviewPrompt(config, task, pr, checkDetails);

    await invokeClaude({
      prompt,
      systemPromptFile: `${PROMPTS_DIR}/review.md`,
      maxTurns: config.maxTurnsPerRun,
      outputFormat: 'text',
      workingDirectory: worktreePath,
    });

    await pushBranch(worktreePath);

    const newStatus = await pollForCIResult(config, pr.number, 10 * 60 * 1000);

    if (newStatus === 'mergeable') return true;
    if (newStatus !== 'failing') return false;
  }

  // Exhausted attempts — mark as blocked
  await addComment(
    config,
    task.number,
    `CI failures could not be resolved after ${MAX_REVIEW_ATTEMPTS} review attempts. Marking as blocked.`,
  );
  await editIssueLabels(config, task.number, ['blocked'], ['in-progress']);
  return false;
}

export async function runExecutorIteration(config: Config, logger: Logger): Promise<void> {
  try {
    await syncRepo(config);
  } catch (error) {
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
    logger.error('Recovery failed', { error: String(error) });
    return;
  }

  try {
    // --- Phase 1: Claim if idle ---
    if (state.activeTaskId === null) {
      const tasks = await listIssues(config, ['task', 'todo']);
      if (tasks.length === 0) {
        logger.info('No tasks available. Sleeping.', {});
        return;
      }

      const claim = await claimTask(config, tasks[0].number);
      if (!claim.success) {
        logger.warn('Claim failed, another executor won', { taskId: tasks[0].number });
        return;
      }

      state = { activeTaskId: claim.taskId, sessionId: null, consecutiveFailures: 0 };
      writeExecutorState(config.executorId, state);
      logger.info('Claimed task', { taskId: claim.taskId });
    }

    // --- Phase 2: Setup worktree ---
    const taskIssues = await listIssues(config, ['task']);
    const task = taskIssues.find((t) => t.number === state.activeTaskId);
    if (!task) {
      logger.error('Could not find task issue', { taskId: state.activeTaskId });
      return;
    }

    const branch = makeBranchName(state.activeTaskId!, task.title);
    const worktreePath = await ensureWorktree(config, state.activeTaskId!, branch);
    await postWorkMapping(config, state.activeTaskId!, branch, worktreePath);

    // --- Phase 3: Implementation ---
    const prompt = buildExecutorPrompt(config, task, branch, worktreePath);
    const result = await invokeClaude({
      prompt,
      systemPromptFile: `${PROMPTS_DIR}/exec.md`,
      maxTurns: config.maxTurnsPerRun,
      outputFormat: 'json',
      workingDirectory: worktreePath,
      resumeSessionId: state.sessionId ?? undefined,
    });

    if (result.sessionId) {
      state.sessionId = result.sessionId;
      writeExecutorState(config.executorId, state);
    }

    // --- Phase 4: PR monitoring ---
    const pr = await findPRByBranch(config, branch);
    if (!pr) {
      logger.info('No PR yet, will continue next iteration', { branch });
      // Successful iteration — reset failure counter
      if ((state.consecutiveFailures ?? 0) > 0) {
        state.consecutiveFailures = 0;
        writeExecutorState(config.executorId, state);
      }
      return;
    }

    await postWorkMapping(config, state.activeTaskId!, branch, worktreePath, pr.number);
    const prStatus = await getPRStatus(config, pr.number);

    switch (prStatus) {
      case 'mergeable':
        await mergePR(config, pr.number);
        await editIssueLabels(config, state.activeTaskId!, ['done'], ['in-progress', `claimed-by:${config.executorId}`]);
        await closeIssue(config, state.activeTaskId!);
        clearActiveTask(config.executorId);
        logger.info('Task complete — PR merged', { taskId: state.activeTaskId, prNumber: pr.number });
        break;

      case 'failing': {
        // --- Phase 5: Review loop ---
        const fixed = await runReviewLoop(config, logger, task, pr, worktreePath);
        if (fixed) {
          await mergePR(config, pr.number);
          await editIssueLabels(config, state.activeTaskId!, ['done'], ['in-progress', `claimed-by:${config.executorId}`]);
          await closeIssue(config, state.activeTaskId!);
          clearActiveTask(config.executorId);
          logger.info('Task complete after review — PR merged', { taskId: state.activeTaskId, prNumber: pr.number });
        }
        break;
      }

      case 'pending':
        logger.info('Checks pending, will re-check next iteration', { prNumber: pr.number });
        break;

      case 'conflicting':
        logger.warn('Merge conflicts detected', { prNumber: pr.number });
        break;
    }

    // Successful iteration — reset failure counter
    if ((state.consecutiveFailures ?? 0) > 0) {
      state.consecutiveFailures = 0;
      writeExecutorState(config.executorId, state);
    }
  } catch (error) {
    logger.error('Executor iteration failed', { error: String(error) });

    // Circuit breaker: track consecutive failures for active tasks
    if (state.activeTaskId !== null) {
      state.consecutiveFailures = (state.consecutiveFailures ?? 0) + 1;
      writeExecutorState(config.executorId, state);

      if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
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
          await editIssueLabels(config, state.activeTaskId, ['blocked'], ['in-progress']);
          clearActiveTask(config.executorId);
        } catch (blockError) {
          logger.error('Failed to mark task as blocked', { error: String(blockError) });
        }
      }
    }
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
