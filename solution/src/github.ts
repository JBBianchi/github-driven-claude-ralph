import { execa } from 'execa';
import { randomUUID } from 'node:crypto';
import { appendToLog } from './log-files.js';
import type { Config, GitHubIssue, GitHubPR, PRStatus, ClaimAttempt } from './types.js';

const WORKFLOW_LABELS = [
  'feature',
  'needs-plan',
  'planned',
  'in-execution',
  'done',
  'plan:draft',
  'plan:needs-clarification',
  'plan:ready',
  'plan:tasks-created',
  'task',
  'todo',
  'in-progress',
  'blocked',
  'needs-human',
];

async function gh(args: string[]): Promise<{ stdout: string }> {
  const start = Date.now();
  try {
    const result = await execa('gh', args, {});
    const stdout = String(result.stdout ?? '');
    const durationMs = Date.now() - start;
    appendToLog('gh.log', `[${new Date().toISOString()}] gh ${args.join(' ')} (${durationMs}ms)\n${stdout}\n---`);
    return { stdout };
  } catch (error: unknown) {
    const durationMs = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    appendToLog('gh.log', `[${new Date().toISOString()}] gh ${args.join(' ')} (${durationMs}ms) ERROR\n${message}\n---`);
    throw error;
  }
}

export async function listIssues(config: Config, labels: string[]): Promise<GitHubIssue[]> {
  const args = [
    'issue', 'list',
    '--repo', config.repoSlug,
    '--state', 'open',
    '--json', 'number,title,body,labels,state',
  ];
  for (const label of labels) {
    args.push('--label', label);
  }

  const { stdout } = await gh(args);
  const raw = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
    state: string;
  }>;

  return raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((l) => l.name),
    state: issue.state as 'OPEN' | 'CLOSED',
  }));
}

export async function createIssue(
  config: Config,
  title: string,
  body: string,
  labels: string[],
): Promise<number> {
  const args = [
    'issue', 'create',
    '--repo', config.repoSlug,
    '--title', title,
    '--body', body,
  ];
  for (const label of labels) {
    args.push('--label', label);
  }

  const { stdout } = await gh(args);
  const url = stdout.trim();
  const match = url.match(/\/issues\/(\d+)$/);
  if (!match) {
    throw new Error(`Could not parse issue number from gh output: ${url}`);
  }
  return parseInt(match[1], 10);
}

export async function editIssueLabels(
  config: Config,
  issueNumber: number,
  add: string[],
  remove: string[],
): Promise<void> {
  if (add.length > 0) {
    await gh([
      'issue', 'edit', String(issueNumber),
      '--repo', config.repoSlug,
      '--add-label', add.join(','),
    ]);
  }
  if (remove.length > 0) {
    await gh([
      'issue', 'edit', String(issueNumber),
      '--repo', config.repoSlug,
      '--remove-label', remove.join(','),
    ]);
  }
}

export async function ensureLabels(config: Config): Promise<void> {
  // List existing labels to avoid overwriting user-customized colors
  const { stdout } = await gh([
    'label', 'list',
    '--repo', config.repoSlug,
    '--json', 'name',
    '--limit', '200',
  ]);
  const existing = new Set(
    (JSON.parse(stdout) as Array<{ name: string }>).map((l) => l.name),
  );

  // Static workflow labels + dynamic claimed-by label for this executor
  const labels = [...WORKFLOW_LABELS];
  if (config.role === 'executor') {
    labels.push(`claimed-by:${config.executorId}`);
  }

  for (const label of labels) {
    if (!existing.has(label)) {
      await gh([
        'label', 'create', label,
        '--repo', config.repoSlug,
      ]);
    }
  }
}

export async function claimTask(config: Config, taskId: number): Promise<ClaimAttempt> {
  const nonce = randomUUID();
  const claimedByLabel = `claimed-by:${config.executorId}`;

  // Step 1: Swap labels
  await editIssueLabels(config, taskId, ['in-progress', claimedByLabel], ['todo']);

  // Step 2: Post nonce comment
  await gh([
    'issue', 'comment', String(taskId),
    '--repo', config.repoSlug,
    '--body', `<!-- claim-nonce:${nonce} executor:${config.executorId} -->`,
  ]);

  // Step 3: Wait for propagation
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Step 4: Re-read labels
  const { stdout: labelsJson } = await gh([
    'issue', 'view', String(taskId),
    '--repo', config.repoSlug,
    '--json', 'labels',
    '-q', '.labels',
  ]);
  const labels = (JSON.parse(labelsJson) as Array<{ name: string }>).map((l) => l.name);

  // Check if another executor's claimed-by label exists
  const claimedByLabels = labels.filter((l) => l.startsWith('claimed-by:'));
  const ourClaimPresent = claimedByLabels.includes(claimedByLabel);
  const otherClaimPresent = claimedByLabels.some((l) => l !== claimedByLabel);

  if (otherClaimPresent || !ourClaimPresent) {
    // Lost the race — unclaim
    await editIssueLabels(config, taskId, ['todo'], ['in-progress', claimedByLabel]);
    return { taskId, nonce, success: false };
  }

  // Step 5: Verify nonce is the latest
  const { stdout: commentsJson } = await gh([
    'issue', 'view', String(taskId),
    '--repo', config.repoSlug,
    '--json', 'comments',
    '-q', '.comments',
  ]);
  const comments = JSON.parse(commentsJson) as Array<{ body: string }>;
  const claimComments = comments.filter((c) => c.body.includes('claim-nonce:'));

  if (claimComments.length > 0) {
    const lastClaim = claimComments[claimComments.length - 1];
    if (!lastClaim.body.includes(`executor:${config.executorId}`)) {
      // Another executor posted a newer nonce
      await editIssueLabels(config, taskId, ['todo'], ['in-progress', claimedByLabel]);
      return { taskId, nonce, success: false };
    }
  }

  return { taskId, nonce, success: true };
}

export async function findPRByBranch(config: Config, branch: string): Promise<GitHubPR | null> {
  const { stdout } = await gh([
    'pr', 'list',
    '--repo', config.repoSlug,
    '--head', branch,
    '--json', 'number,title,headRefName,mergeable,reviewDecision,statusCheckRollup',
  ]);

  const prs = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    headRefName: string;
    mergeable: string;
    reviewDecision: string | null;
    statusCheckRollup: Array<{ conclusion: string | null }>;
  }>;

  if (prs.length === 0) return null;

  const pr = prs[0];
  return {
    number: pr.number,
    title: pr.title,
    headBranch: pr.headRefName,
    mergeable: pr.mergeable as 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN',
    reviewDecision: pr.reviewDecision,
    checksStatus: deriveChecksStatus(pr.statusCheckRollup),
  };
}

function deriveChecksStatus(
  checks: Array<{ conclusion: string | null }>,
): 'passing' | 'failing' | 'pending' {
  if (checks.length === 0) return 'passing';
  if (checks.some((c) => c.conclusion === 'FAILURE')) return 'failing';
  if (checks.some((c) => c.conclusion === null)) return 'pending';
  return 'passing';
}

export async function getPRStatus(config: Config, prNumber: number): Promise<PRStatus> {
  const { stdout } = await gh([
    'pr', 'view', String(prNumber),
    '--repo', config.repoSlug,
    '--json', 'mergeable,reviewDecision,statusCheckRollup',
  ]);

  const pr = JSON.parse(stdout) as {
    mergeable: string;
    reviewDecision: string | null;
    statusCheckRollup: Array<{ conclusion: string | null }>;
  };

  if (pr.mergeable === 'CONFLICTING') return 'conflicting';

  const checksStatus = deriveChecksStatus(pr.statusCheckRollup);
  if (checksStatus === 'failing') return 'failing';
  if (checksStatus === 'pending') return 'pending';

  return 'mergeable';
}

export async function getPRCheckDetails(config: Config, prNumber: number): Promise<string> {
  const { stdout } = await gh([
    'pr', 'checks', String(prNumber),
    '--repo', config.repoSlug,
    '--json', 'name,conclusion,detailsUrl',
  ]);

  const checks = JSON.parse(stdout) as Array<{
    name: string;
    conclusion: string;
    detailsUrl: string;
  }>;

  return checks
    .map((c) => `${c.name}: ${c.conclusion} (${c.detailsUrl})`)
    .join('\n');
}

export async function mergePR(config: Config, prNumber: number): Promise<void> {
  await gh([
    'pr', 'merge', String(prNumber),
    '--repo', config.repoSlug,
    '--squash',
  ]);
}

export async function postWorkMapping(
  config: Config,
  taskId: number,
  branch: string,
  worktreePath: string,
  prNumber?: number,
): Promise<void> {
  const body = [
    '<!-- work-mapping',
    `executor: ${config.executorId}`,
    `branch: ${branch}`,
    `worktree: ${worktreePath}`,
    ...(prNumber !== undefined ? [`pr: ${prNumber}`] : []),
    '-->',
  ].join('\n');

  await gh([
    'issue', 'comment', String(taskId),
    '--repo', config.repoSlug,
    '--body', body,
  ]);
}

export async function addComment(
  config: Config,
  issueNumber: number,
  body: string,
): Promise<void> {
  await gh([
    'issue', 'comment', String(issueNumber),
    '--repo', config.repoSlug,
    '--body', body,
  ]);
}

export async function closeIssue(config: Config, issueNumber: number): Promise<void> {
  await gh([
    'issue', 'close', String(issueNumber),
    '--repo', config.repoSlug,
  ]);
}

export async function requestCopilotReview(config: Config, prNumber: number): Promise<boolean> {
  try {
    await gh([
      'pr', 'edit', String(prNumber),
      '--repo', config.repoSlug,
      '--add-reviewer', 'copilot',
    ]);
    return true;
  } catch {
    // Copilot review may not be available for this repo — ignore gracefully
    return false;
  }
}
