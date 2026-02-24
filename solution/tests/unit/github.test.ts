import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execa } from 'execa';
import {
  listIssues,
  createIssue,
  editIssueLabels,
  ensureLabels,
  claimTask,
  findPRByBranch,
  getPRStatus,
  mergePR,
  getPRCheckDetails,
  postWorkMapping,
  requestCopilotReview,
} from '../../src/github.js';
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

describe('listIssues', () => {
  beforeEach(() => mockExeca.mockReset());

  it('calls gh with correct repo, labels, and JSON fields', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '[]', stderr: '', exitCode: 0 } as any);

    await listIssues(makeConfig(), ['task', 'todo']);

    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining([
        'issue', 'list',
        '--repo', 'org/repo',
        '--label', 'task',
        '--label', 'todo',
        '--json', 'number,title,body,labels,state',
        '--state', 'open',
      ]),
      expect.any(Object),
    );
  });

  it('parses JSON response and flattens label objects', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 1,
          title: 'Task 1',
          body: 'desc',
          labels: [{ name: 'task' }, { name: 'todo' }],
          state: 'OPEN',
        },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);

    const issues = await listIssues(makeConfig(), ['task', 'todo']);

    expect(issues).toHaveLength(1);
    expect(issues[0].labels).toEqual(['task', 'todo']);
    expect(issues[0].number).toBe(1);
    expect(issues[0].title).toBe('Task 1');
  });

  it('returns empty array when no matching issues', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '[]', stderr: '', exitCode: 0 } as any);

    const issues = await listIssues(makeConfig(), ['task', 'todo']);
    expect(issues).toEqual([]);
  });

  it('throws on malformed JSON', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: 'not json', stderr: '', exitCode: 0 } as any);

    await expect(listIssues(makeConfig(), ['task'])).rejects.toThrow();
  });
});

describe('createIssue', () => {
  beforeEach(() => mockExeca.mockReset());

  it('calls gh issue create with correct arguments and parses issue number', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: 'https://github.com/org/repo/issues/42',
      stderr: '',
      exitCode: 0,
    } as any);

    const issueNum = await createIssue(makeConfig(), 'Title', 'Body text', ['task', 'todo']);

    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining([
        'issue', 'create',
        '--repo', 'org/repo',
        '--title', 'Title',
        '--body', 'Body text',
        '--label', 'task',
        '--label', 'todo',
      ]),
      expect.any(Object),
    );
    expect(issueNum).toBe(42);
  });

  it('handles trailing newline in URL', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: 'https://github.com/org/repo/issues/123\n',
      stderr: '',
      exitCode: 0,
    } as any);

    const issueNum = await createIssue(makeConfig(), 'T', 'B', ['task']);
    expect(issueNum).toBe(123);
  });
});

describe('editIssueLabels', () => {
  beforeEach(() => mockExeca.mockReset());

  it('adds and removes labels in separate calls', async () => {
    mockExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);

    await editIssueLabels(makeConfig(), 42, ['in-progress'], ['todo']);

    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['issue', 'edit', '42', '--repo', 'org/repo', '--add-label', 'in-progress']),
      expect.any(Object),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['issue', 'edit', '42', '--repo', 'org/repo', '--remove-label', 'todo']),
      expect.any(Object),
    );
  });

  it('skips add call when add array is empty', async () => {
    mockExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);

    await editIssueLabels(makeConfig(), 42, [], ['todo']);

    // Should only have 1 call (remove), not 2
    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--remove-label', 'todo']),
      expect.any(Object),
    );
  });
});

describe('ensureLabels', () => {
  beforeEach(() => mockExeca.mockReset());

  it('only creates labels that do not already exist', async () => {
    // First call: label list returns some existing labels
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([{ name: 'feature' }, { name: 'task' }]),
      stderr: '',
      exitCode: 0,
    } as any);
    // Remaining calls: label create for each missing label
    mockExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);

    await ensureLabels(makeConfig());

    const calls = mockExeca.mock.calls;
    // First call should be label list
    const listArgs = calls[0][1] as string[];
    expect(listArgs).toContain('label');
    expect(listArgs).toContain('list');
    expect(listArgs).toContain('--repo');

    // Remaining calls should be label create — and should NOT include 'feature' or 'task'
    const createCalls = calls.slice(1);
    const createdLabels = createCalls.map((c) => (c[1] as string[])[2]);
    expect(createdLabels).not.toContain('feature');
    expect(createdLabels).not.toContain('task');
    expect(createdLabels).toContain('needs-plan');
    expect(createdLabels).toContain('todo');
    expect(createdLabels).toContain('blocked');
  });
});

describe('claimTask', () => {
  beforeEach(() => mockExeca.mockReset());

  it('generates nonce, swaps labels, posts comment, verifies ownership', async () => {
    const config = makeConfig();
    // Call 1: add labels (in-progress + claimed-by:executor-01), remove todo
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // Call 2: post comment with nonce
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // Call 3: re-read issue labels
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: 'task' },
        { name: 'in-progress' },
        { name: 'claimed-by:executor-01' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);
    // Call 4: re-read comments to verify nonce
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { body: '<!-- claim-nonce:test-nonce executor:executor-01 -->' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await claimTask(config, 42);

    expect(result.taskId).toBe(42);
    expect(result.success).toBe(true);
    expect(result.nonce).toBeTruthy();
  });

  it('returns success:false when another executor claimed first', async () => {
    const config = makeConfig();
    // Label swap
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // Post comment
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // Re-read labels — another executor's label is present
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: 'task' },
        { name: 'in-progress' },
        { name: 'claimed-by:executor-02' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);
    // Unclaim: restore labels (add todo, remove in-progress, remove claimed-by)
    mockExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);

    const result = await claimTask(config, 42);

    expect(result.success).toBe(false);
  });

  it('returns success:false when a newer nonce comment is found', async () => {
    const config = makeConfig();
    // Label swap
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // Post comment
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // Re-read labels — our label is present
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: 'task' },
        { name: 'in-progress' },
        { name: 'claimed-by:executor-01' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);
    // Re-read comments — newer nonce from different executor
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { body: '<!-- claim-nonce:our-nonce executor:executor-01 -->' },
        { body: '<!-- claim-nonce:newer-nonce executor:executor-02 -->' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);
    // Unclaim calls
    mockExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);

    const result = await claimTask(config, 42);

    expect(result.success).toBe(false);
  });
});

describe('findPRByBranch', () => {
  beforeEach(() => mockExeca.mockReset());

  it('returns PR object when PR exists', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 56,
          title: 'Add login',
          headRefName: 'task/42-add-login',
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          statusCheckRollup: [{ conclusion: 'SUCCESS' }],
        },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);

    const pr = await findPRByBranch(makeConfig(), 'task/42-add-login');

    expect(pr).not.toBeNull();
    expect(pr!.number).toBe(56);
    expect(pr!.title).toBe('Add login');
    expect(pr!.headBranch).toBe('task/42-add-login');
  });

  it('returns null when no PR exists for branch', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '[]', stderr: '', exitCode: 0 } as any);

    const pr = await findPRByBranch(makeConfig(), 'task/42-add-login');
    expect(pr).toBeNull();
  });
});

describe('getPRStatus', () => {
  beforeEach(() => mockExeca.mockReset());

  it('returns mergeable when checks pass and review approved', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        mergeable: 'MERGEABLE',
        reviewDecision: 'APPROVED',
        statusCheckRollup: [{ conclusion: 'SUCCESS' }],
      }),
      stderr: '',
      exitCode: 0,
    } as any);

    const status = await getPRStatus(makeConfig(), 56);
    expect(status).toBe('mergeable');
  });

  it('returns failing when checks fail', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        mergeable: 'MERGEABLE',
        reviewDecision: 'APPROVED',
        statusCheckRollup: [
          { conclusion: 'SUCCESS' },
          { conclusion: 'FAILURE' },
        ],
      }),
      stderr: '',
      exitCode: 0,
    } as any);

    const status = await getPRStatus(makeConfig(), 56);
    expect(status).toBe('failing');
  });

  it('returns pending when checks are in progress', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        statusCheckRollup: [{ conclusion: null }],
      }),
      stderr: '',
      exitCode: 0,
    } as any);

    const status = await getPRStatus(makeConfig(), 56);
    expect(status).toBe('pending');
  });

  it('returns conflicting when mergeable is CONFLICTING', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        mergeable: 'CONFLICTING',
        reviewDecision: null,
        statusCheckRollup: [],
      }),
      stderr: '',
      exitCode: 0,
    } as any);

    const status = await getPRStatus(makeConfig(), 56);
    expect(status).toBe('conflicting');
  });
});

describe('mergePR', () => {
  beforeEach(() => mockExeca.mockReset());

  it('calls gh pr merge with squash strategy', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await mergePR(makeConfig(), 56);

    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'merge', '56', '--squash', '--repo', 'org/repo']),
      expect.any(Object),
    );
  });

  it('propagates error on merge failure', async () => {
    mockExeca.mockRejectedValueOnce(new Error('merge conflict'));

    await expect(mergePR(makeConfig(), 56)).rejects.toThrow('merge conflict');
  });
});

describe('getPRCheckDetails', () => {
  beforeEach(() => mockExeca.mockReset());

  it('returns formatted check failure details', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: 'build', conclusion: 'FAILURE', detailsUrl: 'https://ci.example.com/1' },
        { name: 'lint', conclusion: 'SUCCESS', detailsUrl: 'https://ci.example.com/2' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);

    const details = await getPRCheckDetails(makeConfig(), 56);

    expect(details).toContain('build');
    expect(details).toContain('FAILURE');
  });
});

describe('postWorkMapping', () => {
  beforeEach(() => mockExeca.mockReset());

  it('posts machine-readable HTML comment on issue', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await postWorkMapping(makeConfig(), 42, 'task/42-add-login', '/workspace/worktrees/42', 56);

    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['issue', 'comment', '42', '--repo', 'org/repo']),
      expect.any(Object),
    );

    const args = mockExeca.mock.calls[0][1] as string[];
    const bodyIdx = args.indexOf('--body');
    const body = args[bodyIdx + 1];
    expect(body).toContain('<!-- work-mapping');
    expect(body).toContain('executor: executor-01');
    expect(body).toContain('branch: task/42-add-login');
    expect(body).toContain('worktree: /workspace/worktrees/42');
    expect(body).toContain('pr: 56');
  });
});

describe('requestCopilotReview', () => {
  beforeEach(() => mockExeca.mockReset());

  it('calls gh pr edit with --add-reviewer copilot and returns true', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    const result = await requestCopilotReview(makeConfig(), 56);

    expect(result).toBe(true);
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'edit', '56', '--add-reviewer', 'copilot']),
      expect.any(Object),
    );
  });

  it('returns false when Copilot review is not available', async () => {
    mockExeca.mockRejectedValueOnce(new Error('Could not add reviewer'));

    const result = await requestCopilotReview(makeConfig(), 56);

    expect(result).toBe(false);
  });
});
