import { syncRepo } from './git.js';
import { listIssues } from './github.js';
import { invokeClaude } from './claude.js';
import type { Config, Logger, GitHubIssue } from './types.js';

const PROMPTS_DIR = '/opt/agent/prompts';

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
    const features = await listIssues(config, ['feature', 'needs-plan']);
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
    logger.error('Phase 1 (plan creation) failed', { error: String(error) });
  }

  // Phase 2: Task decomposition
  try {
    const readyPlans = await listIssues(config, ['plan:ready']);
    const plansNeedingTasks = readyPlans.filter(
      (p) => !p.labels.includes('plan:tasks-created'),
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
    logger.error('Phase 2 (task decomposition) failed', { error: String(error) });
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
