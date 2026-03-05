import { execa } from 'execa';
import type { Config } from './types.js';

const REPO_PATH = '/workspace/repo';
const WORKTREES_PATH = '/workspace/worktrees';
const MAX_SYNC_ATTEMPTS = 5;
const RETRY_DELAY_MS = 500;

function shouldRetryGitSync(stderr: string): boolean {
  const patterns = [
    "cannot lock ref 'refs/remotes/origin/",
    "cannot lock ref 'refs/heads/",
    "unable to update local ref",
    "Unable to create '.git/index.lock'",
    "Unable to create '.git/shallow.lock'",
    "Another git process seems to be running",
  ];

  return patterns.some((pattern) => stderr.includes(pattern));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAndReset(config: Config): Promise<void> {
  await execa('git', ['fetch', 'origin'], { cwd: REPO_PATH });
  await execa('git', ['reset', '--hard', `origin/${config.baseBranch}`], { cwd: REPO_PATH });
}

export async function syncRepo(config: Config): Promise<void> {
  const isGitRepo = await execa('git', ['rev-parse', '--git-dir'], { cwd: REPO_PATH })
    .then(() => true)
    .catch(() => false);

  if (isGitRepo) {
    for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
      try {
        await fetchAndReset(config);
        return;
      } catch (error: unknown) {
        const stderr =
          typeof error === 'object' &&
          error !== null &&
          'stderr' in error &&
          typeof (error as { stderr?: unknown }).stderr === 'string'
            ? (error as { stderr: string }).stderr
            : '';

        if (!shouldRetryGitSync(stderr) || attempt === MAX_SYNC_ATTEMPTS) {
          throw error;
        }

        await sleep(RETRY_DELAY_MS);
      }
    }
    return;
  } else {
    await execa('git', ['clone', config.repoUrl, '.'], { cwd: REPO_PATH });
  }
}

export async function ensureWorktree(
  config: Config,
  taskId: number,
  branch: string,
): Promise<string> {
  const worktreePath = `${WORKTREES_PATH}/${taskId}`;

  try {
    await execa('git', ['worktree', 'add', '-b', branch, worktreePath], {
      cwd: REPO_PATH,
    });
  } catch (error: any) {
    const message = error?.stderr || error?.message || '';
    if (message.includes('already exists')) {
      // Worktree already exists, checkout the branch
      await execa('git', ['checkout', branch], { cwd: worktreePath });
    } else {
      throw error;
    }
  }

  return worktreePath;
}

export async function pushBranch(worktreePath: string): Promise<void> {
  await execa('git', ['push', '-u', 'origin', 'HEAD'], { cwd: worktreePath });
}

/**
 * Deletes a remote branch from origin.
 * @param branch - Remote branch name to delete.
 * @returns Resolves when the branch deletion command completes.
 */
export async function deleteRemoteBranch(branch: string): Promise<void> {
  await execa('git', ['push', 'origin', '--delete', branch], { cwd: REPO_PATH });
}

/**
 * Merges the base branch into the current worktree branch.
 * Fetches origin first, then attempts `git merge origin/<baseBranch> --no-edit`.
 * @param config - Application configuration (uses baseBranch).
 * @param worktreePath - Path to the git worktree.
 * @returns `true` if the merge was clean, `false` if there are conflicts to resolve.
 */
export async function mergeBase(config: Config, worktreePath: string): Promise<boolean> {
  await execa('git', ['fetch', 'origin'], { cwd: worktreePath });

  try {
    await execa('git', ['merge', `origin/${config.baseBranch}`, '--no-edit'], { cwd: worktreePath });
    return true;
  } catch (error: unknown) {
    const stderr =
      typeof error === 'object' &&
      error !== null &&
      'stderr' in error &&
      typeof (error as { stderr?: unknown }).stderr === 'string'
        ? (error as { stderr: string }).stderr
        : '';
    const stdout =
      typeof error === 'object' &&
      error !== null &&
      'stdout' in error &&
      typeof (error as { stdout?: unknown }).stdout === 'string'
        ? (error as { stdout: string }).stdout
        : '';

    if (stderr.includes('CONFLICT') || stdout.includes('CONFLICT')) {
      return false;
    }

    throw error;
  }
}

/**
 * Aborts an in-progress merge in the worktree.
 * @param worktreePath - Path to the git worktree.
 */
export async function abortMerge(worktreePath: string): Promise<void> {
  await execa('git', ['merge', '--abort'], { cwd: worktreePath });
}

export function makeBranchName(taskId: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const maxSlugLength = 50 - `task/${taskId}-`.length;
  const truncatedSlug = slug.slice(0, maxSlugLength).replace(/-$/, '');

  return `task/${taskId}-${truncatedSlug}`;
}
