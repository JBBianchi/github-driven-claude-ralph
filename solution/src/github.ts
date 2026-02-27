import { execa } from 'execa';
import { randomUUID } from 'node:crypto';
import { appendToLog } from './log-files.js';
import { CLAIMED_BY_PREFIX, LABELS, WORKFLOW_LABELS, claimedByLabel } from './labels.js';
import type { Config, GitHubIssue, GitHubPR, PRStatus, ClaimAttempt, AgentMeta } from './types.js';

function extractMissingLabelNames(message: string): string[] {
  const matches = [...message.matchAll(/'([^']+)'\s+not found/g)];
  return [...new Set(matches.map((match) => match[1]))];
}

function parseDependsOn(raw: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined;

  const trimmed = raw.trim();
  if (trimmed === '[]') return [];

  const inner = trimmed.startsWith('[') && trimmed.endsWith(']')
    ? trimmed.slice(1, -1).trim()
    : trimmed;
  if (inner.length === 0) return [];

  const values = inner
    .split(',')
    .map((value) => value.trim().replace(/^#/, ''))
    .filter((value) => /^\d+$/.test(value))
    .map((value) => parseInt(value, 10))
    .filter((value) => value > 0);

  if (values.length === 0) return undefined;
  return [...new Set(values)];
}

export function parseAgentMeta(body: string): AgentMeta | null {
  const match = body.match(/<!--\s*agent-meta\s*\n([\s\S]*?)-->/);
  if (!match) return null;

  const fields: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^\s*(\w+)\s*:\s*(.+?)\s*$/);
    if (kv) fields[kv[1]] = kv[2];
  }

  if (!fields['entity'] || !fields['source_feature']) return null;

  return {
    entity: fields['entity'] as 'plan' | 'task',
    source_feature: parseInt(fields['source_feature'], 10),
    source_plan: fields['source_plan'] ? parseInt(fields['source_plan'], 10) : undefined,
    depends_on: parseDependsOn(fields['depends_on']),
  };
}

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

export async function listIssues(
  config: Config,
  labels: string[],
  state: 'open' | 'closed' | 'all' = 'open',
): Promise<GitHubIssue[]> {
  const args = [
    'issue', 'list',
    '--repo', config.repoSlug,
    '--state', state,
    '--json', 'number,title,body,labels,state,updatedAt',
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
    updatedAt?: string;
  }>;

  return raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body,
    labels: issue.labels.map((l) => l.name),
    state: issue.state as 'OPEN' | 'CLOSED',
    updatedAt: issue.updatedAt,
  }));
}

function parseRepoSlug(repoSlug: string): { owner: string; repo: string } {
  const parts = repoSlug.split('/');
  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw new Error(`Invalid repo slug: ${repoSlug}. Expected format "owner/repo".`);
  }

  return { owner: parts[0], repo: parts[1] };
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
    try {
      await gh([
        'issue', 'edit', String(issueNumber),
        '--repo', config.repoSlug,
        '--remove-label', remove.join(','),
      ]);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const missingLabels = extractMissingLabelNames(message);
      if (missingLabels.length === 0) {
        throw error;
      }

      const retryLabels = remove.filter((label) => !missingLabels.includes(label));
      if (retryLabels.length === 0) {
        return;
      }

      await gh([
        'issue', 'edit', String(issueNumber),
        '--repo', config.repoSlug,
        '--remove-label', retryLabels.join(','),
      ]);
    }
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
  const labels: string[] = [...WORKFLOW_LABELS];
  if (config.role === 'executor') {
    labels.push(claimedByLabel(config.executorId));
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
  const claimedBy = claimedByLabel(config.executorId);

  // Step 1: Swap labels
  await editIssueLabels(
    config,
    taskId,
    [LABELS.statusInProgress, claimedBy],
    [LABELS.statusTodo],
  );

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
  const claimedByLabels = labels.filter((l) => l.startsWith(CLAIMED_BY_PREFIX));
  const ourClaimPresent = claimedByLabels.includes(claimedBy);
  const otherClaimPresent = claimedByLabels.some((l) => l !== claimedBy);

  if (otherClaimPresent || !ourClaimPresent) {
    // Lost the race — unclaim
    await editIssueLabels(
      config,
      taskId,
      [LABELS.statusTodo],
      [LABELS.statusInProgress, claimedBy],
    );
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
      await editIssueLabels(
        config,
        taskId,
        [LABELS.statusTodo],
        [LABELS.statusInProgress, claimedBy],
      );
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
    '--json', 'number,title,headRefName,mergeable,reviewDecision,mergeStateStatus',
  ]);

  const prs = JSON.parse(stdout) as Array<{
    number: number;
    title: string;
    headRefName: string;
    mergeable: string;
    reviewDecision: string | null;
    mergeStateStatus?: string;
  }>;

  if (prs.length === 0) return null;

  const pr = prs[0];
  return {
    number: pr.number,
    title: pr.title,
    headBranch: pr.headRefName,
    mergeable: pr.mergeable as 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN',
    reviewDecision: pr.reviewDecision,
    checksStatus: deriveChecksStatusFromMergeState(pr.mergeStateStatus ?? 'UNKNOWN'),
  };
}

function deriveChecksStatusFromMergeState(mergeStateStatus: string): 'passing' | 'failing' | 'pending' {
  const normalized = mergeStateStatus.toUpperCase();
  if (normalized === 'UNSTABLE') return 'failing';
  if (normalized === 'CLEAN') return 'passing';
  return 'pending';
}

function deriveChecksStatusFromCheckRuns(
  checks: Array<{ state?: string }>,
): 'passing' | 'failing' | 'pending' {
  if (checks.length === 0) return 'passing';

  let hasPending = false;
  for (const check of checks) {
    const state = (check.state ?? '').trim().toUpperCase();
    if (state.length === 0) {
      hasPending = true;
      continue;
    }

    if (state === 'FAILURE' || state === 'FAILED' || state === 'CANCELLED' || state === 'TIMED_OUT') {
      return 'failing';
    }

    if (state === 'IN_PROGRESS' || state === 'PENDING' || state === 'QUEUED' || state === 'WAITING') {
      hasPending = true;
    }
  }

  return hasPending ? 'pending' : 'passing';
}

async function getPRChecksStatus(config: Config, prNumber: number): Promise<'passing' | 'failing' | 'pending'> {
  try {
    const { stdout } = await gh([
      'pr', 'checks', String(prNumber),
      '--repo', config.repoSlug,
      '--json', 'state',
    ]);

    const checks = JSON.parse(stdout) as Array<{ state?: string }>;
    return deriveChecksStatusFromCheckRuns(checks);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    // GitHub may temporarily return this before check suites materialize.
    if (/no checks reported on the/i.test(message)) {
      return 'pending';
    }

    // Conservative fallback: if checks cannot be read, do not merge yet.
    if (/resource not accessible by personal access token/i.test(message)) {
      return 'pending';
    }

    throw error;
  }
}

export async function getPRStatus(config: Config, prNumber: number): Promise<PRStatus> {
  const { stdout } = await gh([
    'pr', 'view', String(prNumber),
    '--repo', config.repoSlug,
    '--json', 'mergeable,reviewDecision,mergeStateStatus',
  ]);

  const pr = JSON.parse(stdout) as {
    mergeable: string;
    reviewDecision: string | null;
    mergeStateStatus?: string;
  };

  const mergeStateStatus = (pr.mergeStateStatus ?? 'UNKNOWN').toUpperCase();
  if (pr.mergeable === 'CONFLICTING' || mergeStateStatus === 'DIRTY') return 'conflicting';

  const mergeStateChecks = deriveChecksStatusFromMergeState(mergeStateStatus);
  if (mergeStateChecks === 'failing') return 'failing';
  if (mergeStateChecks === 'pending') return 'pending';

  const checksStatus = await getPRChecksStatus(config, prNumber);
  if (checksStatus === 'failing') return 'failing';
  if (checksStatus === 'pending') return 'pending';

  // Merge when checks pass unless GitHub reports an explicitly blocking review state.
  const reviewDecision = (pr.reviewDecision ?? '').trim().toUpperCase();
  if (reviewDecision === 'REVIEW_REQUIRED' || reviewDecision === 'CHANGES_REQUESTED') {
    return 'pending';
  }

  return 'mergeable';
}

export async function getPRCheckDetails(config: Config, prNumber: number): Promise<string> {
  const { stdout } = await gh([
    'pr', 'checks', String(prNumber),
    '--repo', config.repoSlug,
    '--json', 'name,state,link',
  ]);

  const checks = JSON.parse(stdout) as Array<{
    name: string;
    state?: string;
    link?: string;
  }>;

  return checks
    .map((c) => `${c.name}: ${c.state ?? 'UNKNOWN'} (${c.link ?? 'n/a'})`)
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
    const { owner, repo } = parseRepoSlug(config.repoSlug);
    await gh([
      'api',
      '--method', 'POST',
      `/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`,
      '-f', 'reviewers[]=github-copilot',
    ]);
    return true;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already requested/i.test(message)) {
      return true;
    }

    // Copilot review may not be available for this repo — ignore gracefully
    return false;
  }
}

