import { syncRepo } from './git.js';
import {
  listIssues,
  editIssueLabels,
  closeIssue,
  parseAgentMeta,
  addComment,
} from './github.js';
import { invokeClaude } from './claude.js';
import { LABELS } from './labels.js';
import type { Config, Logger, GitHubIssue } from './types.js';

const PROMPTS_DIR = '/opt/agent/prompts';
const WAITING_STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const CLAUDE_AUTH_FAILURE_PREFIX = 'Claude authentication failed:';

function isFatalClaudeAuthError(error: unknown): boolean {
  return String(error).includes(CLAUDE_AUTH_FAILURE_PREFIX);
}

function hasLabel(issue: GitHubIssue, label: string): boolean {
  return issue.labels.includes(label);
}

function getWaitingAgeMs(task: GitHubIssue): number | null {
  if (!task.updatedAt) return null;
  const updatedAtMs = Date.parse(task.updatedAt);
  if (Number.isNaN(updatedAtMs)) return null;
  return Date.now() - updatedAtMs;
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
  try {
    await syncRepo(config);
  } catch (error) {
    logger.error('Failed to sync repo', { error: String(error) });
    return;
  }

  // Phase 1: Plan creation
  try {
    const features = await listIssues(config, [LABELS.feature, LABELS.needsPlan]);
    if (features.length > 0) {
      logger.info('Found features needing plans', { count: features.length });
      const prompt = buildPlannerPrompt(config, features);
      logger.info('Invoking Claude for plan creation', {});
      const result = await invokeClaude({
        prompt,
        systemPromptFile: `${PROMPTS_DIR}/plan.md`,
        maxTurns: config.maxTurnsPerRun,
        outputFormat: 'text',
        workingDirectory: '/workspace/repo',
      });
      logger.info('Claude plan creation finished', {
        success: result.success,
        durationMs: result.durationMs,
        outputLength: result.result?.length ?? 0,
        outputPreview: result.result?.slice(0, 500) ?? '(no output)',
      });
    }
  } catch (error) {
    if (isFatalClaudeAuthError(error)) {
      logger.error('Fatal Claude authentication failure. Stopping planner loop.', { error: String(error) });
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
      await invokeClaude({
        prompt,
        systemPromptFile: `${PROMPTS_DIR}/tasks.md`,
        maxTurns: config.maxTurnsPerRun,
        outputFormat: 'text',
        workingDirectory: '/workspace/repo',
      });
    }
  } catch (error) {
    if (isFatalClaudeAuthError(error)) {
      logger.error('Fatal Claude authentication failure. Stopping planner loop.', { error: String(error) });
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

      for (const task of openTasks) {
        const meta = parseAgentMeta(task.body);
        if (!meta || meta.entity !== 'task') continue;

        const dependencies = meta.depends_on ?? [];
        const unresolvedDependencies = dependencies.filter((issueNumber) => !doneTaskNumbers.has(issueNumber));
        const isWaiting = hasLabel(task, LABELS.statusWaiting);
        const isTodo = hasLabel(task, LABELS.statusTodo);

        if (unresolvedDependencies.length === 0) {
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

        let transitionedToWaiting = false;
        if (isTodo) {
          await editIssueLabels(
            config,
            task.number,
            [LABELS.statusWaiting],
            [LABELS.statusTodo],
          );
          transitionedToWaiting = true;
          logger.info('Moved task to waiting due to unresolved dependencies', {
            taskNumber: task.number,
            unresolvedDependencies,
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

  // Phase 4: Plan completion
  try {
    const plansWithTasks = await listIssues(config, [LABELS.planTasksCreated]);
    if (plansWithTasks.length > 0) {
      const openTasks = await listIssues(config, [LABELS.task]);
      for (const plan of plansWithTasks) {
        const remaining = openTasks.filter((t) => {
          const meta = parseAgentMeta(t.body);
          return meta?.source_plan === plan.number;
        });
        if (remaining.length === 0) {
          await editIssueLabels(config, plan.number, [LABELS.planDone], [LABELS.planTasksCreated]);
          await closeIssue(config, plan.number);
          logger.info('Plan complete - all tasks done', { planNumber: plan.number });

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
