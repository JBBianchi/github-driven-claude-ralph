import { syncRepo } from './git.js';
import {
  listIssues,
  editIssueLabels,
  closeIssue,
  parseAgentMeta,
  addComment,
} from './github.js';
import { isFatalAgentAuthError } from './agent-auth.js';
import { invokeAgent } from './agent-cli.js';
import { getClaudeSubagents } from './subagents.js';
import { LABELS } from './labels.js';
import type { Config, Logger, GitHubIssue } from './types.js';

const PROMPTS_DIR = '/opt/agent/prompts';
const WAITING_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

function hasLabel(issue: GitHubIssue, label: string): boolean {
  return issue.labels.includes(label);
}

function getWaitingAgeMs(task: GitHubIssue): number | null {
  if (!task.updatedAt) return null;
  const updatedAtMs = Date.parse(task.updatedAt);
  if (Number.isNaN(updatedAtMs)) return null;
  return Date.now() - updatedAtMs;
}

/**
 * Builds the prompt for autonomous codebase analysis.
 *
 * @param config - Agent configuration.
 * @param existingIssues - Open feature/plan/task issues to avoid duplicates.
 * @returns The prompt string for Claude.
 */
export function buildAutonomousPrompt(
  config: Config,
  existingIssues: GitHubIssue[],
): string {
  const issueList = existingIssues.length > 0
    ? existingIssues.map((i) => `- #${i.number}: [${i.labels.join(', ')}] ${i.title}`).join('\n')
    : '(none)';

  const focusLine = config.autonomousFocus
    ? `\nFocus area: ${config.autonomousFocus}`
    : '';

  return `You are the Planner agent for repository ${config.repoSlug}.
Working directory: /workspace/repo (synced to ${config.baseBranch})

Analyze the codebase and identify up to ${config.autonomousMaxFeatures} improvements or features to create as GitHub issues.${focusLine}

Existing open issues (do NOT duplicate these):
${issueList}

Create feature issues labeled "feature" and "needs-plan". Use \`gh\` for all GitHub API operations.
Repository: ${config.repoSlug}`;
}

export function buildPlannerPrompt(config: Config, features: GitHubIssue[]): string {
  const featureList = features.map((f) => `- #${f.number}: ${f.title}`).join('\n');
  return `You are the Planner agent for repository ${config.repoSlug}.
Working directory: /workspace/repo (synced to ${config.baseBranch})

The following feature issues need plans:
${featureList}

Process each feature. Use \`gh\` for all GitHub API operations.
Repository: ${config.repoSlug}`;
}

export function buildTaskDecompPrompt(config: Config, plans: GitHubIssue[]): string {
  const planList = plans.map((p) => `- #${p.number}: ${p.title}`).join('\n');
  return `You are the Planner agent for repository ${config.repoSlug}.
Working directory: /workspace/repo (synced to ${config.baseBranch})

The following approved plans need task decomposition:
${planList}

Create task issues for each plan. Use \`gh\` for all GitHub API operations.
Repository: ${config.repoSlug}`;
}

export async function runPlannerIteration(config: Config, logger: Logger): Promise<void> {
  const claudeSubagents = getClaudeSubagents(config.role, config.claudeSubagentsEnabled);

  try {
    await syncRepo(config);
  } catch (error) {
    logger.error('Failed to sync repo', { error: String(error) });
    return;
  }

  // Phase 0: Autonomous analysis (opt-in, self-regulating)
  if (config.autonomousMode) {
    try {
      const pendingFeatures = await listIssues(config, [LABELS.needsPlan]);
      const readyPlans = await listIssues(config, [LABELS.planReady]);
      const openTasks = await listIssues(config, [LABELS.task]);

      const pipelineBusy = pendingFeatures.length > 0 || readyPlans.length > 0 || openTasks.length > 0;

      if (pipelineBusy) {
        logger.info('Autonomous mode: pipeline busy, skipping analysis', {
          pendingFeatures: pendingFeatures.length,
          readyPlans: readyPlans.length,
          openTasks: openTasks.length,
        });
      } else {
        const existingFeatures = await listIssues(config, [LABELS.feature]);
        const existingIssues = [...existingFeatures];

        logger.info('Autonomous mode: analyzing codebase', {
          existingIssueCount: existingIssues.length,
          maxFeatures: config.autonomousMaxFeatures,
          focus: config.autonomousFocus || '(open-ended)',
        });

        const prompt = buildAutonomousPrompt(config, existingIssues);
        const result = await invokeAgent({
          provider: config.agentProvider,
          prompt,
          systemPromptFile: `${PROMPTS_DIR}/analyze.md`,
          maxTurns: config.maxTurnsPerRun,
          outputFormat: 'text',
          workingDirectory: '/workspace/repo',
          model: config.agentModel,
          agents: claudeSubagents,
        });

        logger.info('Autonomous analysis finished', {
          success: result.success,
          durationMs: result.durationMs,
          outputLength: result.result?.length ?? 0,
          outputPreview: result.result?.slice(0, 500) ?? '(no output)',
        });
      }
    } catch (error) {
      if (isFatalAgentAuthError(error)) {
        logger.error('Fatal agent authentication failure. Stopping planner loop.', {
          error: String(error),
        });
        throw error;
      }
      logger.error('Phase 0 (autonomous analysis) failed', { error: String(error) });
    }
  }

  // Phase 1: Plan creation
  try {
    const features = await listIssues(config, [LABELS.needsPlan]);
    if (features.length > 0) {
      logger.info('Found features needing plans', { count: features.length });
      const prompt = buildPlannerPrompt(config, features);
      logger.info('Invoking agent for plan creation', { provider: config.agentProvider });
      const result = await invokeAgent({
        provider: config.agentProvider,
        prompt,
        systemPromptFile: `${PROMPTS_DIR}/plan.md`,
        maxTurns: config.maxTurnsPerRun,
        outputFormat: 'text',
        workingDirectory: '/workspace/repo',
        model: config.agentModel,
        agents: claudeSubagents,
      });
      logger.info('Agent plan creation finished', {
        success: result.success,
        durationMs: result.durationMs,
        outputLength: result.result?.length ?? 0,
        outputPreview: result.result?.slice(0, 500) ?? '(no output)',
      });
    }
  } catch (error) {
    if (isFatalAgentAuthError(error)) {
      logger.error('Fatal agent authentication failure. Stopping planner loop.', { error: String(error) });
      throw error;
    }
    logger.error('Phase 1 (plan creation) failed', { error: String(error) });
  }

  // Phase 2: Task decomposition
  try {
    const readyPlans = await listIssues(config, [LABELS.planReady]);
    const plansNeedingTasks = readyPlans.filter(
      (p) => !p.labels.includes(LABELS.planTasksCreated),
    );
    if (plansNeedingTasks.length > 0) {
      logger.info('Found plans needing task decomposition', { count: plansNeedingTasks.length });
      const prompt = buildTaskDecompPrompt(config, plansNeedingTasks);
      await invokeAgent({
        provider: config.agentProvider,
        prompt,
        systemPromptFile: `${PROMPTS_DIR}/tasks.md`,
        maxTurns: config.maxTurnsPerRun,
        outputFormat: 'text',
        workingDirectory: '/workspace/repo',
        model: config.agentModel,
        agents: claudeSubagents,
      });
    }
  } catch (error) {
    if (isFatalAgentAuthError(error)) {
      logger.error('Fatal agent authentication failure. Stopping planner loop.', { error: String(error) });
      throw error;
    }
    logger.error('Phase 2 (task decomposition) failed', { error: String(error) });
  }

  // Phase 3: Task readiness scheduling
  try {
    const openTasks = await listIssues(config, [LABELS.task]);
    if (openTasks.length > 0) {
      const doneTasks = await listIssues(config, [LABELS.task, LABELS.statusDone], 'all');
      const doneTaskNumbers = new Set(doneTasks.map((task) => task.number));

      // Plan-sequential gating: only allow tasks from the N lowest-numbered
      // incomplete plans to be promoted to status:todo.
      let activePlanNumbers: Set<number> | null = null;
      if (config.maxConcurrentPlans > 0) {
        const incompletePlans = await listIssues(config, [LABELS.planTasksCreated]);
        const sortedPlans = [...incompletePlans].sort((a, b) => a.number - b.number);
        const activePlans = sortedPlans.slice(0, config.maxConcurrentPlans);
        activePlanNumbers = new Set(activePlans.map((p) => p.number));
      }

      for (const task of openTasks) {
        const meta = parseAgentMeta(task.body);
        if (!meta || meta.entity !== 'task') continue;

        const dependencies = meta.depends_on ?? [];
        const unresolvedDependencies = dependencies.filter((issueNumber) => !doneTaskNumbers.has(issueNumber));
        const isWaiting = hasLabel(task, LABELS.statusWaiting);
        const isTodo = hasLabel(task, LABELS.statusTodo);

        // Check plan-level gating: task's plan must be in the active set
        const planGated = activePlanNumbers !== null
          && meta.source_plan !== undefined
          && !activePlanNumbers.has(meta.source_plan);

        if (unresolvedDependencies.length === 0 && !planGated) {
          if (isWaiting) {
            await editIssueLabels(
              config,
              task.number,
              [LABELS.statusTodo],
              [LABELS.statusWaiting],
            );
            logger.info('Promoted waiting task to todo', { taskNumber: task.number });
          }
          continue;
        }

        // Task should be waiting: either has unresolved deps or is plan-gated
        let transitionedToWaiting = false;
        if (isTodo) {
          await editIssueLabels(
            config,
            task.number,
            [LABELS.statusWaiting],
            [LABELS.statusTodo],
          );
          transitionedToWaiting = true;
          logger.info('Moved task to waiting', {
            taskNumber: task.number,
            unresolvedDependencies,
            planGated,
          });
        }

        if (isWaiting && !transitionedToWaiting) {
          const waitingAgeMs = getWaitingAgeMs(task);
          if (waitingAgeMs !== null && waitingAgeMs >= WAITING_STALE_THRESHOLD_MS) {
            const blockers = unresolvedDependencies.map((issueNumber) => `#${issueNumber}`).join(', ');
            await addComment(
              config,
              task.number,
              `<!-- waiting-stale -->\nTask is still blocked by unresolved dependencies: ${blockers}.`,
            );
          }
        }
      }
    }
  } catch (error) {
    logger.error('Phase 3 (task readiness scheduling) failed', { error: String(error) });
  }

  // Phase 4: Plan completion (positive done-verification)
  try {
    const plansWithTasks = await listIssues(config, [LABELS.planTasksCreated]);
    if (plansWithTasks.length > 0) {
      const allTasks = await listIssues(config, [LABELS.task], 'all');
      for (const plan of plansWithTasks) {
        const planTasks = allTasks.filter((t) => {
          const meta = parseAgentMeta(t.body);
          return meta?.source_plan === plan.number;
        });

        // Plan must have at least one known task, and ALL must be status:done
        if (planTasks.length === 0) continue;
        const allDone = planTasks.every((t) => hasLabel(t, LABELS.statusDone));
        if (!allDone) continue;

        await editIssueLabels(config, plan.number, [LABELS.planDone], [LABELS.planTasksCreated]);
        await closeIssue(config, plan.number);
        logger.info('Plan complete - all tasks done', {
          planNumber: plan.number,
          taskCount: planTasks.length,
        });

        // Close source feature if plan has agent-meta
        const planMeta = parseAgentMeta(plan.body);
        if (planMeta?.source_feature) {
          await editIssueLabels(config, planMeta.source_feature, [LABELS.statusDone], [LABELS.planned]);
          await closeIssue(config, planMeta.source_feature);
          logger.info('Feature complete - plan done', {
            featureNumber: planMeta.source_feature,
            planNumber: plan.number,
          });
        }
      }
    }
  } catch (error) {
    logger.error('Phase 4 (plan completion) failed', { error: String(error) });
  }
}

export async function runPlannerLoop(
  config: Config,
  logger: Logger,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  logger.info('Planner loop starting', { pollInterval: config.pollIntervalSeconds });

  while (shouldContinue()) {
    await runPlannerIteration(config, logger);
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalSeconds * 1000));
  }

  logger.info('Planner loop shutting down gracefully', {});
}
