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
  parseAgentMeta,
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
    autonomousMode: false,
    autonomousMaxFeatures: 3,
    autonomousFocus: '',
    maxConcurrentPlans: 0,
    ...overrides,
  };
}

describe('listIssues', () => {
  beforeEach(() => mockExeca.mockReset());

  it('calls gh with correct repo, labels, and JSON fields', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '[]', stderr: '', exitCode: 0 } as any);

    await listIssues(makeConfig(), ['task', 'status:todo']);

    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining([
        'issue', 'list',
        '--repo', 'org/repo',
        '--limit', '500',
        '--label', 'task',
        '--label', 'status:todo',
        '--json', 'number,title,body,labels,state,updatedAt',
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
          labels: [{ name: 'task' }, { name: 'status:todo' }],
          state: 'OPEN',
        },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);

    const issues = await listIssues(makeConfig(), ['task', 'status:todo']);

    expect(issues).toHaveLength(1);
    expect(issues[0].labels).toEqual(['task', 'status:todo']);
    expect(issues[0].number).toBe(1);
    expect(issues[0].title).toBe('Task 1');
  });

  it('returns empty array when no matching issues', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '[]', stderr: '', exitCode: 0 } as any);

    const issues = await listIssues(makeConfig(), ['task', 'status:todo']);
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

    const issueNum = await createIssue(makeConfig(), 'Title', 'Body text', ['task', 'status:todo']);

    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining([
        'issue', 'create',
        '--repo', 'org/repo',
        '--title', 'Title',
        '--body', 'Body text',
        '--label', 'task',
        '--label', 'status:todo',
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

    await editIssueLabels(makeConfig(), 42, ['status:in-progress'], ['status:todo']);

    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['issue', 'edit', '42', '--repo', 'org/repo', '--add-label', 'status:in-progress']),
      expect.any(Object),
    );
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['issue', 'edit', '42', '--repo', 'org/repo', '--remove-label', 'status:todo']),
      expect.any(Object),
    );
  });

  it('skips add call when add array is empty', async () => {
    mockExeca.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 } as any);

    await editIssueLabels(makeConfig(), 42, [], ['status:todo']);

    // Should only have 1 call (remove), not 2
    expect(mockExeca).toHaveBeenCalledTimes(1);
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['--remove-label', 'status:todo']),
      expect.any(Object),
    );
  });

  it('retries remove without missing labels when gh reports label not found', async () => {
    mockExeca
      .mockRejectedValueOnce(new Error("'status:todo' not found"))
      .mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    await editIssueLabels(makeConfig(), 42, [], ['status:waiting', 'status:todo']);

    expect(mockExeca).toHaveBeenNthCalledWith(
      1,
      'gh',
      expect.arrayContaining(['--remove-label', 'status:waiting,status:todo']),
      expect.any(Object),
    );
    expect(mockExeca).toHaveBeenNthCalledWith(
      2,
      'gh',
      expect.arrayContaining(['--remove-label', 'status:waiting']),
      expect.any(Object),
    );
  });

  it('swallows remove failure when all labels are missing', async () => {
    mockExeca.mockRejectedValueOnce(new Error("'status:todo' not found"));

    await expect(editIssueLabels(makeConfig(), 42, [], ['status:todo'])).resolves.toBeUndefined();
    expect(mockExeca).toHaveBeenCalledTimes(1);
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
    expect(createdLabels).toContain('status:todo');
    expect(createdLabels).toContain('status:blocked');
    expect(createdLabels).toContain('status:waiting');
  });
});

describe('claimTask', () => {
  beforeEach(() => mockExeca.mockReset());

  it('wins when latest nonce is ours and removes competing claimed-by labels', async () => {
    const config = makeConfig();

    // Initial claim entry (add, remove) + nonce comment
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    // Initial snapshot: latest claim is ours, but another claimed-by label exists
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        labels: [
          { name: 'task' },
          { name: 'status:in-progress' },
          { name: 'claimed-by:executor-01' },
          { name: 'claimed-by:executor-02' },
        ],
        comments: [
          { body: '<!-- claim-nonce:older executor:executor-02 -->' },
          { body: '<!-- claim-nonce:newer executor:executor-01 -->' },
        ],
      }),
      stderr: '',
      exitCode: 0,
    } as any);

    // Winner finalization (add, remove)
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    // Verification snapshot still shows competing label due propagation lag
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        labels: [
          { name: 'task' },
          { name: 'status:in-progress' },
          { name: 'claimed-by:executor-01' },
          { name: 'claimed-by:executor-02' },
        ],
        comments: [
          { body: '<!-- claim-nonce:older executor:executor-02 -->' },
          { body: '<!-- claim-nonce:newer executor:executor-01 -->' },
        ],
      }),
      stderr: '',
      exitCode: 0,
    } as any);

    // Explicit competing claim cleanup
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    const result = await claimTask(config, 42);

    expect(result.taskId).toBe(42);
    expect(result.success).toBe(true);
    expect(result.nonce).toBeTruthy();
    expect(result.reason).toBeUndefined();

    const removeCompetingCall = mockExeca.mock.calls.find((call) => {
      const args = call[1] as string[];
      return args.includes('--remove-label') && args.includes('claimed-by:executor-02');
    });
    expect(removeCompetingCall).toBeTruthy();
  });

  it('returns success:false when latest nonce belongs to another executor and keeps in-progress claimed by winner', async () => {
    const config = makeConfig();

    // Initial claim entry (add, remove) + nonce comment
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    // Initial snapshot: latest claim belongs to executor-02
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        labels: [
          { name: 'task' },
          { name: 'status:in-progress' },
          { name: 'claimed-by:executor-01' },
          { name: 'claimed-by:executor-02' },
        ],
        comments: [
          { body: '<!-- claim-nonce:older executor:executor-01 -->' },
          { body: '<!-- claim-nonce:newer executor:executor-02 -->' },
        ],
      }),
      stderr: '',
      exitCode: 0,
    } as any);

    // Loser cleanup removes only our claimed-by label
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // Remaining labels still include winner claim, so no todo restore
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: 'task' },
        { name: 'status:in-progress' },
        { name: 'claimed-by:executor-02' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await claimTask(config, 42);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('lost-race');
    expect(result.ownerExecutorId).toBe('executor-02');

    const removedInProgress = mockExeca.mock.calls.some((call) => {
      const args = call[1] as string[];
      return args.includes('--remove-label') && args.includes('status:in-progress');
    });
    expect(removedInProgress).toBe(false);
  });

  it('restores todo and removes in-progress when loser cleanup finds no remaining claim labels', async () => {
    const config = makeConfig();

    // Initial claim entry (add, remove) + nonce comment
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    // Initial snapshot: race lost to executor-02
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        labels: [
          { name: 'task' },
          { name: 'status:in-progress' },
          { name: 'claimed-by:executor-01' },
        ],
        comments: [
          { body: '<!-- claim-nonce:our-nonce executor:executor-01 -->' },
          { body: '<!-- claim-nonce:newer-nonce executor:executor-02 -->' },
        ],
      }),
      stderr: '',
      exitCode: 0,
    } as any);

    // Loser cleanup: remove our claim label
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);
    // No remaining claim labels => restore todo / clear in-progress
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: 'task' },
        { name: 'status:in-progress' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // add todo
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any); // remove in-progress

    const result = await claimTask(config, 42);

    expect(result.success).toBe(false);
    expect(result.reason).toBe('lost-race');
    expect(result.ownerExecutorId).toBe('executor-02');

    const addTodoCall = mockExeca.mock.calls.find((call) => {
      const args = call[1] as string[];
      return args.includes('--add-label') && args.includes('status:todo');
    });
    const removeInProgressCall = mockExeca.mock.calls.find((call) => {
      const args = call[1] as string[];
      return args.includes('--remove-label') && args.includes('status:in-progress');
    });
    expect(addTodoCall).toBeTruthy();
    expect(removeInProgressCall).toBeTruthy();
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
          mergeStateStatus: 'CLEAN',
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
        mergeStateStatus: 'CLEAN',
      }),
      stderr: '',
      exitCode: 0,
    } as any);
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: 'build (ubuntu-latest)', state: 'SUCCESS' },
        { name: 'build (windows-latest)', state: 'SUCCESS' },
        { name: 'build (macos-latest)', state: 'SUCCESS' },
      ]),
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
        mergeStateStatus: 'UNSTABLE',
      }),
      stderr: '',
      exitCode: 0,
    } as any);

    const status = await getPRStatus(makeConfig(), 56);
    expect(status).toBe('failing');
  });

  it('returns mergeable when checks pass and no review decision is present', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        mergeable: 'MERGEABLE',
        reviewDecision: '',
        mergeStateStatus: 'CLEAN',
      }),
      stderr: '',
      exitCode: 0,
    } as any);
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: 'build (ubuntu-latest)', state: 'SUCCESS' },
        { name: 'build (windows-latest)', state: 'SUCCESS' },
        { name: 'build (macos-latest)', state: 'SUCCESS' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);

    const status = await getPRStatus(makeConfig(), 56);
    expect(status).toBe('mergeable');
  });

  it('returns pending when review is required', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        mergeable: 'MERGEABLE',
        reviewDecision: 'REVIEW_REQUIRED',
        mergeStateStatus: 'CLEAN',
      }),
      stderr: '',
      exitCode: 0,
    } as any);
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: 'build (ubuntu-latest)', state: 'SUCCESS' },
        { name: 'build (windows-latest)', state: 'SUCCESS' },
        { name: 'build (macos-latest)', state: 'SUCCESS' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);

    const status = await getPRStatus(makeConfig(), 56);
    expect(status).toBe('pending');
  });

  it('returns pending when changes are requested', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        mergeable: 'MERGEABLE',
        reviewDecision: 'CHANGES_REQUESTED',
        mergeStateStatus: 'CLEAN',
      }),
      stderr: '',
      exitCode: 0,
    } as any);
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: 'build (ubuntu-latest)', state: 'SUCCESS' },
        { name: 'build (windows-latest)', state: 'SUCCESS' },
        { name: 'build (macos-latest)', state: 'SUCCESS' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);

    const status = await getPRStatus(makeConfig(), 56);
    expect(status).toBe('pending');
  });

  it('returns pending when any check is still in progress despite CLEAN merge state', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        mergeable: 'MERGEABLE',
        reviewDecision: '',
        mergeStateStatus: 'CLEAN',
      }),
      stderr: '',
      exitCode: 0,
    } as any);
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: 'build (ubuntu-latest)', state: 'IN_PROGRESS' },
        { name: 'build (windows-latest)', state: 'SUCCESS' },
        { name: 'build (macos-latest)', state: 'SUCCESS' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);

    const status = await getPRStatus(makeConfig(), 56);
    expect(status).toBe('pending');
  });

  it('returns failing when any check has failed despite CLEAN merge state', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        mergeable: 'MERGEABLE',
        reviewDecision: '',
        mergeStateStatus: 'CLEAN',
      }),
      stderr: '',
      exitCode: 0,
    } as any);
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: 'build (ubuntu-latest)', state: 'FAILURE' },
        { name: 'build (windows-latest)', state: 'SUCCESS' },
        { name: 'build (macos-latest)', state: 'SUCCESS' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);

    const status = await getPRStatus(makeConfig(), 56);
    expect(status).toBe('failing');
  });

  it('returns pending when merge state is blocked', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        mergeable: 'MERGEABLE',
        reviewDecision: null,
        mergeStateStatus: 'BLOCKED',
      }),
      stderr: '',
      exitCode: 0,
    } as any);

    const status = await getPRStatus(makeConfig(), 56);
    expect(status).toBe('pending');
  });

  it('returns pending when mergeStateStatus is unavailable', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        mergeable: 'MERGEABLE',
        reviewDecision: 'APPROVED',
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
        mergeStateStatus: 'UNKNOWN',
      }),
      stderr: '',
      exitCode: 0,
    } as any);

    const status = await getPRStatus(makeConfig(), 56);
    expect(status).toBe('conflicting');
  });

  it('returns mergeable when merge state is CLEAN but token lacks checks permission', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        mergeable: 'MERGEABLE',
        reviewDecision: '',
        mergeStateStatus: 'CLEAN',
      }),
      stderr: '',
      exitCode: 0,
    } as any);
    mockExeca.mockRejectedValueOnce(
      new Error('GraphQL: Resource not accessible by personal access token'),
    );

    const status = await getPRStatus(makeConfig(), 56);
    expect(status).toBe('mergeable');
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
        { name: 'build', state: 'FAIL', link: 'https://ci.example.com/1' },
        { name: 'lint', state: 'PASS', link: 'https://ci.example.com/2' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);

    const details = await getPRCheckDetails(makeConfig(), 56);

    expect(details).toContain('build');
    expect(details).toContain('FAIL');
  });

  it('handles missing state/link fields defensively', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { name: 'build' },
      ]),
      stderr: '',
      exitCode: 0,
    } as any);

    const details = await getPRCheckDetails(makeConfig(), 56);

    expect(details).toContain('build: UNKNOWN (n/a)');
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

  it('calls gh api requested_reviewers endpoint and returns true', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 0 } as any);

    const result = await requestCopilotReview(makeConfig(), 56);

    expect(result).toBe(true);
    expect(mockExeca).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining([
        'api',
        '--method', 'POST',
        '/repos/org/repo/pulls/56/requested_reviewers',
        '-f', 'reviewers[]=github-copilot',
      ]),
      expect.any(Object),
    );
  });

  it('returns false when Copilot review is not available', async () => {
    mockExeca.mockRejectedValueOnce(new Error('Could not add reviewer'));

    const result = await requestCopilotReview(makeConfig(), 56);

    expect(result).toBe(false);
  });

  it('returns true when reviewer is already requested', async () => {
    mockExeca.mockRejectedValueOnce(new Error('is already requested'));

    const result = await requestCopilotReview(makeConfig(), 56);

    expect(result).toBe(true);
  });
});

describe('parseAgentMeta', () => {
  it('parses a complete task meta block', () => {
    const body = `Some text
<!-- agent-meta
entity: task
source_feature: 10
source_plan: 5
depends_on: [2, 3]
-->
More text`;
    const meta = parseAgentMeta(body);
    expect(meta).toEqual({
      entity: 'task',
      source_feature: 10,
      source_plan: 5,
      depends_on: [2, 3],
    });
  });

  it('parses a plan meta block (no source_plan)', () => {
    const body = `<!-- agent-meta
entity: plan
source_feature: 10
-->`;
    const meta = parseAgentMeta(body);
    expect(meta).toEqual({
      entity: 'plan',
      source_feature: 10,
      source_plan: undefined,
      depends_on: undefined,
    });
  });

  it('parses empty dependency list', () => {
    const body = `<!-- agent-meta
entity: task
source_feature: 10
source_plan: 5
depends_on: []
-->`;
    const meta = parseAgentMeta(body);
    expect(meta?.depends_on).toEqual([]);
  });

  it('returns null when no meta block exists', () => {
    expect(parseAgentMeta('just a plain body')).toBeNull();
  });

  it('returns null when required fields are missing', () => {
    const body = `<!-- agent-meta
source_plan: 5
-->`;
    expect(parseAgentMeta(body)).toBeNull();
  });
});


