import { execa } from 'execa';
import type { Config } from './types.js';

const REPO_PATH = '/workspace/repo';
const WORKTREES_PATH = '/workspace/worktrees';

export async function syncRepo(config: Config): Promise<void> {
  try {
    await execa('git', ['rev-parse', '--git-dir'], { cwd: REPO_PATH });
    // Repo exists — fetch and reset
    await execa('git', ['fetch', 'origin'], { cwd: REPO_PATH });
    await execa('git', ['reset', '--hard', `origin/${config.baseBranch}`], { cwd: REPO_PATH });
  } catch {
    // Not a git repo — clone into it (use '.' to clone into existing directory)
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
