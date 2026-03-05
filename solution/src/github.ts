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

interface ClaimComment {
  nonce: string;
  executorId: string;
}

interface IssueClaimSnapshot {
  labels: string[];
  comments: Array<{ body: string }>;
}

function parseClaimComment(body: string): ClaimComment | null {
  const match = body.match(/claim-nonce:([^\s]+)\s+executor:([^\s>]+)/);
  if (!match) return null;
  return { nonce: match[1], executorId: match[2] };
}

function latestClaimComment(comments: Array<{ body: string }>): ClaimComment | null {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const parsed = parseClaimComment(comments[i].body);
    if (parsed) return parsed;
  }
  return null;
}

function claimedByLabels(labels: string[]): string[] {
  return labels.filter((label) => label.startsWith(CLAIMED_BY_PREFIX));
}

function executorIdFromClaimedByLabel(label: string): string | undefined {
  if (!label.startsWith(CLAIMED_BY_PREFIX)) return undefined;
  const executorId = label.slice(CLAIMED_BY_PREFIX.length);
  return executorId.length > 0 ? executorId : undefined;
}

function logClaimEvent(taskId: number, message: string, context: Record<string, unknown>): void {
  appendToLog(
    'gh.log',
    `[${new Date().toISOString()}] claim task ${taskId} ${message} ${JSON.stringify(context)}\n---`,
  );
}

async function readClaimSnapshot(config: Config, taskId: number): Promise<IssueClaimSnapshot> {
  const { stdout } = await gh([
    'issue', 'view', String(taskId),
    '--repo', config.repoSlug,
    '--json', 'labels,comments',
  ]);
  const raw = JSON.parse(stdout) as {
    labels?: Array<{ name?: string }>;
    comments?: Array<{ body?: string }>;
  };

  return {
    labels: (raw.labels ?? [])
      .map((label) => label.name ?? '')
      .filter((label) => label.length > 0),
    comments: (raw.comments ?? []).map((comment) => ({ body: comment.body ?? '' })),
  };
}

async function readIssueLabels(config: Config, taskId: number): Promise<string[]> {
  const { stdout } = await gh([
    'issue', 'view', String(taskId),
    '--repo', config.repoSlug,
    '--json', 'labels',
    '-q', '.labels',
  ]);
  return (JSON.parse(stdout) as Array<{ name: string }>).map((label) => label.name);
}

async function finalizeWinningClaim(
  config: Config,
  taskId: number,
  claimedBy: string,
  labels: string[],
): Promise<void> {
  const competingClaims = claimedByLabels(labels).filter((label) => label !== claimedBy);
  await editIssueLabels(
    config,
    taskId,
    [LABELS.statusInProgress, claimedBy],
    [LABELS.statusTodo, ...competingClaims],
  );
}

async function cleanupLosingClaim(
  config: Config,
  taskId: number,
  claimedBy: string,
): Promise<void> {
  await editIssueLabels(config, taskId, [], [claimedBy]);
  const labelsAfterCleanup = await readIssueLabels(config, taskId);
  const remainingClaims = claimedByLabels(labelsAfterCleanup);
  if (remainingClaims.length > 0) {
    return;
  }

  await editIssueLabels(config, taskId, [LABELS.statusTodo], [LABELS.statusInProgress]);
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
    '--limit', '500',
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

  // Step 1: Try to enter the claim set.
  await editIssueLabels(
    config,
    taskId,
    [LABELS.statusInProgress, claimedBy],
    [LABELS.statusTodo],
  );

  // Step 2: Publish claim nonce for deterministic winner election.
  await gh([
    'issue', 'comment', String(taskId),
    '--repo', config.repoSlug,
    '--body', `<!-- claim-nonce:${nonce} executor:${config.executorId} -->`,
  ]);

  // Step 3: Wait briefly for issue view consistency.
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Step 4: Determine winner from latest claim nonce.
  const initialSnapshot = await readClaimSnapshot(config, taskId);
  const latestClaim = latestClaimComment(initialSnapshot.comments);
  if (!latestClaim || latestClaim.executorId !== config.executorId) {
    await cleanupLosingClaim(config, taskId, claimedBy);
    logClaimEvent(taskId, 'lost-race', {
      executorId: config.executorId,
      nonce,
      latestClaimExecutorId: latestClaim?.executorId ?? null,
      latestClaimNonce: latestClaim?.nonce ?? null,
    });
    return {
      taskId,
      nonce,
      success: false,
      reason: 'lost-race',
      ownerExecutorId: latestClaim?.executorId,
    };
  }

  // Step 5: Winner finalizes labels.
  await finalizeWinningClaim(config, taskId, claimedBy, initialSnapshot.labels);

  // Step 6: Verify winner still owns latest claim and labels are coherent.
  const verifySnapshot = await readClaimSnapshot(config, taskId);
  const latestAfterFinalize = latestClaimComment(verifySnapshot.comments);
  if (
    !latestAfterFinalize
    || latestAfterFinalize.executorId !== config.executorId
  ) {
    await cleanupLosingClaim(config, taskId, claimedBy);
    logClaimEvent(taskId, 'lost-race-after-finalize', {
      executorId: config.executorId,
      nonce,
      latestClaimExecutorId: latestAfterFinalize?.executorId ?? null,
      latestClaimNonce: latestAfterFinalize?.nonce ?? null,
    });
    return {
      taskId,
      nonce,
      success: false,
      reason: 'lost-race',
      ownerExecutorId: latestAfterFinalize?.executorId,
    };
  }

  const verifyClaimLabels = claimedByLabels(verifySnapshot.labels);
  const ourClaimPresent = verifyClaimLabels.includes(claimedBy);
  if (!ourClaimPresent) {
    const ownerExecutorId = executorIdFromClaimedByLabel(verifyClaimLabels[0] ?? '');
    logClaimEvent(taskId, 'missing-claim-label', {
      executorId: config.executorId,
      nonce,
      labels: verifySnapshot.labels,
      ownerExecutorId: ownerExecutorId ?? null,
    });
    return {
      taskId,
      nonce,
      success: false,
      reason: 'missing-claim-label',
      ownerExecutorId,
    };
  }

  const inProgressPresent = verifySnapshot.labels.includes(LABELS.statusInProgress);
  if (!inProgressPresent) {
    logClaimEvent(taskId, 'missing-in-progress-label', {
      executorId: config.executorId,
      nonce,
      labels: verifySnapshot.labels,
    });
    return {
      taskId,
      nonce,
      success: false,
      reason: 'missing-in-progress-label',
    };
  }

  const competingClaims = verifyClaimLabels.filter((label) => label !== claimedBy);
  if (competingClaims.length > 0) {
    await editIssueLabels(config, taskId, [], competingClaims);
    logClaimEvent(taskId, 'removed-competing-claims', {
      executorId: config.executorId,
      nonce,
      competingClaims,
    });
  }

  logClaimEvent(taskId, 'claim-success', { executorId: config.executorId, nonce });
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

async function getPRChecksStatus(config: Config, prNumber: number): Promise<'passing' | 'failing' | 'pending' | 'unknown'> {
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

    // No check suites exist for this branch/PR; treat as passing.
    if (/no checks reported on the/i.test(message)) {
      return 'passing';
    }

    // Permission error — cannot determine check status; let caller decide.
    if (/resource not accessible by personal access token/i.test(message)) {
      return 'unknown';
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

