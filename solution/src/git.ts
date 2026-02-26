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
