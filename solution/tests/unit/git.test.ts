import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execa } from 'execa';
import { syncRepo, ensureWorktree, pushBranch, makeBranchName } from '../../src/git.js';
import type { Config } from '../../src/types.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const mockExeca = vi.mocked(execa);

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    role: 'executor',
    repoUrl: 'https://github.com/org/repo.git',
    repoSlug: 'org/repo',
    baseBranch: 'main',
    ghToken: 'ghp_test',
    pollIntervalSeconds: 60,
    executorId: 'executor-01',
    maxTurnsPerRun: 50,
    gitCommitSigning: 'off',
    gitSigningKey: '',
    signingKeysMount: '/mnt/host-keys',
    validationCommand: '',
    gitAuthorName: 'Bot',
    gitAuthorEmail: 'bot@test.com',
    ...overrides,
  };
}

describe('syncRepo', () => {
  beforeEach(() => {
    mockExeca.mockReset();
  });

  it('clones repo when .git does not exist', async () => {
    // First call: rev-parse to check if repo exists — fails (no repo)
    mockExeca.mockRejectedValueOnce(new Error('not a git repository'));
    // Second call: clone
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await syncRepo(makeConfig());

    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['rev-parse', '--git-dir']),
      expect.objectContaining({ cwd: '/workspace/repo' }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['clone', 'https://github.com/org/repo.git', '.'],
      expect.any(Object),
    );
  });

  it('fetches and resets when repo already exists', async () => {
    // rev-parse succeeds (repo exists)
    mockExeca.mockResolvedValueOnce({ stdout: '.git', stderr: '', exitCode: 0 } as any);
    // fetch
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // reset
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await syncRepo(makeConfig());

    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['fetch', 'origin'],
      expect.objectContaining({ cwd: '/workspace/repo' }),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['reset', '--hard', 'origin/main'],
      expect.objectContaining({ cwd: '/workspace/repo' }),
    );
  });

  it('uses config.baseBranch for reset target', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '.git', stderr: '', exitCode: 0 } as any);
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await syncRepo(makeConfig({ baseBranch: 'develop' }));

    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['reset', '--hard', 'origin/develop'],
      expect.any(Object),
    );
  });

  it('propagates error when clone fails', async () => {
    mockExeca.mockRejectedValueOnce(new Error('not a git repository'));
    mockExeca.mockRejectedValueOnce(new Error('fatal: remote not found'));

    await expect(syncRepo(makeConfig())).rejects.toThrow('fatal: remote not found');
  });

  it('propagates fetch error without falling through to clone', async () => {
    // rev-parse succeeds (repo exists)
    mockExeca.mockResolvedValueOnce({ stdout: '.git', stderr: '', exitCode: 0 } as any);
    // fetch fails (network issue)
    mockExeca.mockRejectedValueOnce(new Error('fatal: unable to access remote'));

    await expect(syncRepo(makeConfig())).rejects.toThrow('fatal: unable to access remote');
    // Should NOT attempt clone — only 2 calls (rev-parse + fetch)
    expect(mockExeca).toHaveBeenCalledTimes(2);
  });

  it('retries sync on git ref lock contention and then succeeds', async () => {
    vi.useFakeTimers();
    try {
      const lockError = new Error('cannot lock ref') as Error & { stderr: string };
      lockError.stderr =
        "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def";

      mockExeca.mockResolvedValueOnce({ stdout: '.git', stderr: '', exitCode: 0 } as any);
      mockExeca.mockRejectedValueOnce(lockError);
      mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
      mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

      const promise = syncRepo(makeConfig());
      await vi.runAllTimersAsync();
      await promise;

      expect(mockExeca).toHaveBeenCalledTimes(4);
      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['fetch', 'origin'],
        expect.objectContaining({ cwd: '/workspace/repo' }),
      );
      expect(mockExeca).toHaveBeenCalledWith(
        'git',
        ['reset', '--hard', 'origin/main'],
        expect.objectContaining({ cwd: '/workspace/repo' }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws after max retry attempts on persistent ref lock contention', async () => {
    vi.useFakeTimers();
    try {
      const lockError = new Error('cannot lock ref') as Error & { stderr: string };
      lockError.stderr =
        "error: cannot lock ref 'refs/remotes/origin/main': is at abc but expected def";

      mockExeca.mockResolvedValueOnce({ stdout: '.git', stderr: '', exitCode: 0 } as any);
      mockExeca.mockRejectedValueOnce(lockError);
      mockExeca.mockRejectedValueOnce(lockError);
      mockExeca.mockRejectedValueOnce(lockError);
      mockExeca.mockRejectedValueOnce(lockError);
      mockExeca.mockRejectedValueOnce(lockError);

      const promise = syncRepo(makeConfig());
      const expectation = expect(promise).rejects.toThrow('cannot lock ref');
      await vi.runAllTimersAsync();
      await expectation;
      expect(mockExeca).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ensureWorktree', () => {
  beforeEach(() => {
    mockExeca.mockReset();
  });

  it('creates new worktree with correct path and branch', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    const path = await ensureWorktree(makeConfig(), 42, 'task/42-add-login');

    expect(path).toBe('/workspace/worktrees/42');
    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['worktree', 'add', '-b', 'task/42-add-login', '/workspace/worktrees/42'],
      expect.objectContaining({ cwd: '/workspace/repo' }),
    );
  });

  it('reuses existing worktree if path already exists', async () => {
    const error = new Error('already checked out') as any;
    error.stderr = "fatal: '/workspace/worktrees/42' already exists";
    mockExeca.mockRejectedValueOnce(error);
    // Checkout in existing worktree
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    const path = await ensureWorktree(makeConfig(), 42, 'task/42-add-login');

    expect(path).toBe('/workspace/worktrees/42');
  });

  it('sets cwd to /workspace/repo for git worktree command', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await ensureWorktree(makeConfig(), 42, 'task/42-add-login');

    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      expect.any(Array),
      expect.objectContaining({ cwd: '/workspace/repo' }),
    );
  });
});

describe('pushBranch', () => {
  beforeEach(() => {
    mockExeca.mockReset();
  });

  it('calls git push with correct cwd', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await pushBranch('/workspace/worktrees/42');

    expect(mockExeca).toHaveBeenCalledWith(
      'git',
      ['push', '-u', 'origin', 'HEAD'],
      expect.objectContaining({ cwd: '/workspace/worktrees/42' }),
    );
  });

  it('propagates error on push failure', async () => {
    mockExeca.mockRejectedValueOnce(new Error('push rejected'));

    await expect(pushBranch('/workspace/worktrees/42')).rejects.toThrow('push rejected');
  });
});

describe('makeBranchName', () => {
  it('generates task/<id>-<slugified-title>', () => {
    expect(makeBranchName(42, 'Add Login Page')).toBe('task/42-add-login-page');
  });

  it('truncates long titles', () => {
    const longTitle = 'A'.repeat(200);
    const result = makeBranchName(42, longTitle);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result).toMatch(/^task\/42-/);
  });

  it('removes special characters', () => {
    const result = makeBranchName(42, 'Fix: handle "quotes" & <brackets>');
    expect(result).toMatch(/^task\/42-[a-z0-9-]+$/);
    expect(result).not.toMatch(/[":&<>]/);
  });
});
