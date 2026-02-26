import { describe, it, expect, beforeEach, vi } from 'vitest';
import { syncRepo, ensureWorktree, pushBranch, makeBranchName } from '../../src/git.js';
import {
  listIssues,
  claimTask,
  findPRByBranch,
  getPRStatus,
  getPRCheckDetails,
  mergePR,
  editIssueLabels,
  closeIssue,
  postWorkMapping,
  addComment,
  requestCopilotReview,
} from '../../src/github.js';
import { invokeClaude } from '../../src/claude.js';
import {
  readExecutorState,
  writeExecutorState,
  clearActiveTask,
  recoverStateFromGitHub,
} from '../../src/state.js';
import {
  runExecutorIteration,
  runExecutorLoop,
  buildExecutorPrompt,
  buildReviewPrompt,
  pollForCIResult,
} from '../../src/executor.js';
import type { Config, Logger, GitHubIssue, GitHubPR } from '../../src/types.js';

vi.mock('../../src/git.js', () => ({
  syncRepo: vi.fn(),
  ensureWorktree: vi.fn(),
  pushBranch: vi.fn(),
  makeBranchName: vi.fn(),
}));

vi.mock('../../src/github.js', () => ({
  listIssues: vi.fn(),
  claimTask: vi.fn(),
  findPRByBranch: vi.fn(),
  getPRStatus: vi.fn(),
  getPRCheckDetails: vi.fn(),
  mergePR: vi.fn(),
  editIssueLabels: vi.fn(),
  closeIssue: vi.fn(),
  postWorkMapping: vi.fn(),
  addComment: vi.fn(),
  requestCopilotReview: vi.fn(),
}));

vi.mock('../../src/claude.js', () => ({
  invokeClaude: vi.fn(),
}));

vi.mock('../../src/state.js', () => ({
  readExecutorState: vi.fn(),
  writeExecutorState: vi.fn(),
  clearActiveTask: vi.fn(),
  recoverStateFromGitHub: vi.fn(),
}));

const mockSyncRepo = vi.mocked(syncRepo);
const mockEnsureWorktree = vi.mocked(ensureWorktree);
const mockPushBranch = vi.mocked(pushBranch);
const mockMakeBranchName = vi.mocked(makeBranchName);
const mockListIssues = vi.mocked(listIssues);
const mockClaimTask = vi.mocked(claimTask);
const mockFindPRByBranch = vi.mocked(findPRByBranch);
const mockGetPRStatus = vi.mocked(getPRStatus);
const mockGetPRCheckDetails = vi.mocked(getPRCheckDetails);
const mockMergePR = vi.mocked(mergePR);
const mockEditIssueLabels = vi.mocked(editIssueLabels);
const mockCloseIssue = vi.mocked(closeIssue);
const mockPostWorkMapping = vi.mocked(postWorkMapping);
const mockAddComment = vi.mocked(addComment);
const mockRequestCopilotReview = vi.mocked(requestCopilotReview);
const mockInvokeClaude = vi.mocked(invokeClaude);
const mockReadExecutorState = vi.mocked(readExecutorState);
const mockWriteExecutorState = vi.mocked(writeExecutorState);
const mockClearActiveTask = vi.mocked(clearActiveTask);
const mockRecoverStateFromGitHub = vi.mocked(recoverStateFromGitHub);

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
    validationCommand: 'npm test',
    gitAuthorName: 'Bot',
    gitAuthorEmail: 'bot@test.com',
    ...overrides,
  };
}

function makeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeTask(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 42,
    title: 'Task: Add button',
    body: 'Add a submit button to the form',
    labels: ['task', 'status:todo'],
    state: 'OPEN',
    ...overrides,
  };
}

function makePR(overrides: Partial<GitHubPR> = {}): GitHubPR {
  return {
    number: 56,
    title: 'Add button',
    headBranch: 'task/42-add-button',
    mergeable: 'MERGEABLE',
    reviewDecision: 'APPROVED',
    checksStatus: 'passing',
    ...overrides,
  };
}

describe('runExecutorIteration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSyncRepo.mockResolvedValue(undefined);
    mockMakeBranchName.mockReturnValue('task/42-add-button');
    mockEnsureWorktree.mockResolvedValue('/workspace/worktrees/42');
    mockPushBranch.mockResolvedValue(undefined);
    mockPostWorkMapping.mockResolvedValue(undefined);
    mockEditIssueLabels.mockResolvedValue(undefined);
    mockCloseIssue.mockResolvedValue(undefined);
    mockAddComment.mockResolvedValue(undefined);
    mockMergePR.mockResolvedValue(undefined);
    mockRequestCopilotReview.mockResolvedValue(true);
    mockWriteExecutorState.mockReturnValue(undefined);
    mockClearActiveTask.mockReturnValue(undefined);
  });

  // --- Phase 0: Recovery ---

  it('reads local state at start of iteration', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: null, sessionId: null });
    mockListIssues.mockResolvedValue([]);

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockReadExecutorState).toHaveBeenCalledWith('executor-01');
  });

  it('recovers from GitHub when local state is null', async () => {
    mockReadExecutorState.mockReturnValue(null);
    mockRecoverStateFromGitHub.mockResolvedValue({ activeTaskId: 42, sessionId: null });
    // Set up rest of flow for active task
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, sessionId: 'sess-1', durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(null);

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockRecoverStateFromGitHub).toHaveBeenCalled();
    expect(mockWriteExecutorState).toHaveBeenCalled();
  });

  it('proceeds to claim when both local and GitHub state are empty', async () => {
    mockReadExecutorState.mockReturnValue(null);
    mockRecoverStateFromGitHub.mockResolvedValue({ activeTaskId: null, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockClaimTask.mockResolvedValue({ taskId: 42, nonce: 'abc', success: true });
    mockInvokeClaude.mockResolvedValue({ success: true, sessionId: 'sess-1', durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(null);

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockClaimTask).toHaveBeenCalled();
  });

  // --- Phase 1: Claim ---

  it('claims oldest available task when idle', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: null, sessionId: null });
    mockListIssues.mockResolvedValue([
      makeTask({ number: 43, title: 'Task: Newer task' }),
      makeTask({ number: 42, title: 'Task: Older task' }),
    ]);
    mockClaimTask.mockResolvedValue({ taskId: 42, nonce: 'abc', success: true });
    mockInvokeClaude.mockResolvedValue({ success: true, sessionId: 'sess-1', durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(null);

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockClaimTask).toHaveBeenCalledWith(expect.anything(), 42);
    expect(mockWriteExecutorState).toHaveBeenCalledWith(
      'executor-01',
      expect.objectContaining({ activeTaskId: 42 }),
    );
  });

  it('returns early when no tasks available', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: null, sessionId: null });
    mockListIssues.mockResolvedValue([]);

    const logger = makeLogger();
    await runExecutorIteration(makeConfig(), logger);

    expect(mockInvokeClaude).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('No tasks'),
      expect.anything(),
    );
  });

  it('returns early when claim fails', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: null, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockClaimTask.mockResolvedValue({ taskId: 42, nonce: 'abc', success: false });

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockInvokeClaude).not.toHaveBeenCalled();
  });

  // --- Phase 2: Worktree ---

  it('clears stale state when active task issue is missing', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([]);

    const logger = makeLogger();
    await runExecutorIteration(makeConfig(), logger);

    expect(mockClearActiveTask).toHaveBeenCalledWith('executor-01');
    expect(mockInvokeClaude).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('clearing stale state'),
      expect.objectContaining({ taskId: 42 }),
    );
  });

  it('creates worktree for claimed task', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, sessionId: 'sess-1', durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(null);

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockEnsureWorktree).toHaveBeenCalledWith(
      expect.anything(), 42, 'task/42-add-button',
    );
    expect(mockPostWorkMapping).toHaveBeenCalled();
  });

  // --- Phase 3: Implementation ---

  it('invokes Claude with correct prompt, cwd, system prompt', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, sessionId: 'sess-1', durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(null);

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockInvokeClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: '/workspace/worktrees/42',
        outputFormat: 'json',
        maxTurns: 50,
      }),
    );
    const call = mockInvokeClaude.mock.calls[0][0];
    expect(call.systemPromptFile).toContain('exec.md');
    expect(call.prompt).toContain('#42');
    expect(call.prompt).toContain('Add button');
  });

  it('returns early when Claude implementation invocation fails', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: false, durationMs: 100 });

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockFindPRByBranch).not.toHaveBeenCalled();
  });

  it('rethrows fatal Claude authentication errors to stop loop', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockRejectedValue(new Error('Claude authentication failed: OAuth token has expired.'));

    await expect(runExecutorIteration(makeConfig(), makeLogger())).rejects.toThrow('Claude authentication failed');
  });

  it('saves sessionId from Claude result to state', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, sessionId: 'sess-new', durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(null);

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockWriteExecutorState).toHaveBeenCalledWith(
      'executor-01',
      expect.objectContaining({ sessionId: 'sess-new' }),
    );
  });

  it('passes resumeSessionId when state has existing sessionId', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: 'sess-old' });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(null);

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockInvokeClaude).toHaveBeenCalledWith(
      expect.objectContaining({ resumeSessionId: 'sess-old' }),
    );
  });

  // --- Phase 4: PR monitoring ---

  it('finds PR by branch and checks status', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(makePR());
    mockGetPRStatus.mockResolvedValue('mergeable');

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockFindPRByBranch).toHaveBeenCalledWith(expect.anything(), 'task/42-add-button');
    expect(mockGetPRStatus).toHaveBeenCalledWith(expect.anything(), 56);
  });

  it('requests Copilot review when PR is found', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(makePR());
    mockGetPRStatus.mockResolvedValue('mergeable');

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockRequestCopilotReview).toHaveBeenCalledWith(expect.anything(), 56);
  });

  it('logs warning when Copilot review request is unavailable', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(makePR());
    mockRequestCopilotReview.mockResolvedValue(false);
    mockGetPRStatus.mockResolvedValue('pending');

    const logger = makeLogger();
    await runExecutorIteration(makeConfig(), logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Copilot review request unavailable'),
      expect.objectContaining({ prNumber: 56 }),
    );
  });

  it('returns early when no PR exists yet', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(null);

    const logger = makeLogger();
    await runExecutorIteration(makeConfig(), logger);

    expect(mockMergePR).not.toHaveBeenCalled();
  });

  it('merges PR and cleans up state when status is mergeable', async () => {
    const config = makeConfig();
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(makePR());
    mockGetPRStatus.mockResolvedValue('mergeable');

    await runExecutorIteration(config, makeLogger());

    expect(mockMergePR).toHaveBeenCalledWith(expect.anything(), 56);
    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(), 42,
      ['status:done'],
      ['status:in-progress', 'claimed-by:executor-01'],
    );
    expect(mockCloseIssue).toHaveBeenCalledWith(expect.anything(), 42);
    expect(mockClearActiveTask).toHaveBeenCalledWith('executor-01');
  });

  it('does nothing on pending status', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(makePR());
    mockGetPRStatus.mockResolvedValue('pending');

    const logger = makeLogger();
    await runExecutorIteration(makeConfig(), logger);

    expect(mockMergePR).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('pending'),
      expect.anything(),
    );
  });

  it('logs warning when status is conflicting', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(makePR());
    mockGetPRStatus.mockResolvedValue('conflicting');

    const logger = makeLogger();
    await runExecutorIteration(makeConfig(), logger);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('conflict'),
      expect.anything(),
    );
  });

  // --- Phase 5: Review loop ---

  it('enters review loop when PR status is failing', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(makePR());
    mockGetPRStatus.mockResolvedValueOnce('failing');
    mockGetPRCheckDetails.mockResolvedValue('build: FAILURE');
    // After review, CI passes
    mockGetPRStatus.mockResolvedValueOnce('mergeable');

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockGetPRCheckDetails).toHaveBeenCalled();
    // Claude called twice: once for implementation, once for review
    expect(mockInvokeClaude).toHaveBeenCalledTimes(2);
  });

  it('pushes branch after each review attempt', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(makePR());
    mockGetPRStatus.mockResolvedValueOnce('failing');
    mockGetPRCheckDetails.mockResolvedValue('build: FAILURE');
    mockGetPRStatus.mockResolvedValueOnce('mergeable');

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockPushBranch).toHaveBeenCalledWith('/workspace/worktrees/42');
  });

  it('merges if CI passes after fix', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(makePR());
    mockGetPRStatus.mockResolvedValueOnce('failing');
    mockGetPRCheckDetails.mockResolvedValue('build: FAILURE');
    mockGetPRStatus.mockResolvedValueOnce('mergeable');

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockMergePR).toHaveBeenCalled();
  });

  it('retries review up to 3 times', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(makePR());
    // Initial status: failing
    mockGetPRStatus.mockResolvedValueOnce('failing');
    mockGetPRCheckDetails.mockResolvedValue('build: FAILURE');
    // After each review attempt, still failing
    mockGetPRStatus.mockResolvedValueOnce('failing');
    mockGetPRStatus.mockResolvedValueOnce('failing');
    mockGetPRStatus.mockResolvedValueOnce('failing');

    await runExecutorIteration(makeConfig(), makeLogger());

    // 1 implementation + 3 review = 4 total Claude calls
    expect(mockInvokeClaude).toHaveBeenCalledTimes(4);
  });

  it('marks task as blocked after exhausting review attempts', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(makePR());
    mockGetPRStatus.mockResolvedValueOnce('failing');
    mockGetPRCheckDetails.mockResolvedValue('build: FAILURE');
    mockGetPRStatus.mockResolvedValueOnce('failing');
    mockGetPRStatus.mockResolvedValueOnce('failing');
    mockGetPRStatus.mockResolvedValueOnce('failing');

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(), 42, ['status:blocked'], ['status:in-progress'],
    );
    expect(mockAddComment).toHaveBeenCalled();
  });

  // --- Error handling ---

  it('catches and logs errors without crashing', async () => {
    mockReadExecutorState.mockReturnValue(null);
    mockRecoverStateFromGitHub.mockRejectedValue(new Error('network error'));

    const logger = makeLogger();
    await runExecutorIteration(makeConfig(), logger);

    expect(logger.error).toHaveBeenCalled();
  });

  // --- Circuit breaker ---

  it('increments consecutiveFailures on iteration error with active task', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null, consecutiveFailures: 0 });
    // Make listIssues throw after recovery succeeds (phases 1-5 try block)
    mockListIssues.mockRejectedValue(new Error('API error'));

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockWriteExecutorState).toHaveBeenCalledWith(
      'executor-01',
      expect.objectContaining({ consecutiveFailures: 1 }),
    );
  });

  it('marks task blocked after 3 consecutive failures', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null, consecutiveFailures: 2 });
    mockListIssues.mockRejectedValue(new Error('API error'));

    await runExecutorIteration(makeConfig(), makeLogger());

    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(), 42, ['status:blocked'], ['status:in-progress'],
    );
    expect(mockClearActiveTask).toHaveBeenCalledWith('executor-01');
  });

  it('resets consecutiveFailures on successful iteration with active task', async () => {
    mockReadExecutorState.mockReturnValue({ activeTaskId: 42, sessionId: null, consecutiveFailures: 2 });
    mockListIssues.mockResolvedValue([makeTask()]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockFindPRByBranch.mockResolvedValue(null);

    await runExecutorIteration(makeConfig(), makeLogger());

    // The last writeExecutorState call should have consecutiveFailures: 0
    const calls = mockWriteExecutorState.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1]).toEqual(expect.objectContaining({ consecutiveFailures: 0 }));
  });
});

describe('buildExecutorPrompt', () => {
  it('includes task number, title, body, and validation command', () => {
    const task = makeTask();
    const config = makeConfig({ validationCommand: 'npm test' });
    const prompt = buildExecutorPrompt(config, task, 'task/42-add-button', '/workspace/worktrees/42');

    expect(prompt).toContain('#42');
    expect(prompt).toContain('Add button');
    expect(prompt).toContain('Add a submit button to the form');
    expect(prompt).toContain('npm test');
  });

  it('handles empty validation command', () => {
    const task = makeTask();
    const config = makeConfig({ validationCommand: '' });
    const prompt = buildExecutorPrompt(config, task, 'task/42-add-button', '/workspace/worktrees/42');

    expect(prompt).toContain('No validation command configured');
  });
});

describe('buildReviewPrompt', () => {
  it('includes check failure details', () => {
    const task = makeTask();
    const pr = makePR();
    const prompt = buildReviewPrompt(makeConfig(), task, pr, 'build: FAILURE\nlint: SUCCESS');

    expect(prompt).toContain('build: FAILURE');
    expect(prompt).toContain('#42');
    expect(prompt).toContain('#56');
  });
});

describe('pollForCIResult', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns immediately when status is not pending', async () => {
    mockGetPRStatus.mockResolvedValue('mergeable');

    const result = await pollForCIResult(makeConfig(), 56, 60_000, 1);

    expect(result).toBe('mergeable');
    expect(mockGetPRStatus).toHaveBeenCalledTimes(1);
  });

  it('returns failing immediately without polling', async () => {
    mockGetPRStatus.mockResolvedValue('failing');

    const result = await pollForCIResult(makeConfig(), 56, 60_000, 1);

    expect(result).toBe('failing');
    expect(mockGetPRStatus).toHaveBeenCalledWith(expect.anything(), 56);
  });

  it('polls until status changes from pending', async () => {
    mockGetPRStatus
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce('mergeable');

    const result = await pollForCIResult(makeConfig(), 56, 60_000, 1);

    expect(result).toBe('mergeable');
    expect(mockGetPRStatus).toHaveBeenCalledTimes(3);
  });

  it('returns pending when timeout is reached', async () => {
    mockGetPRStatus.mockResolvedValue('pending');

    // With timeout=0, the deadline is already past
    const result = await pollForCIResult(makeConfig(), 56, 0, 1);

    expect(result).toBe('pending');
  });
});

describe('runExecutorLoop', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSyncRepo.mockResolvedValue(undefined);
    mockReadExecutorState.mockReturnValue({ activeTaskId: null, sessionId: null });
    mockListIssues.mockResolvedValue([]);
  });

  it('exits after current iteration when shouldContinue returns false', async () => {
    let calls = 0;
    const logger = makeLogger();

    await runExecutorLoop(
      makeConfig({ pollIntervalSeconds: 0 }),
      logger,
      () => { calls++; return calls <= 1; },
    );

    expect(mockSyncRepo).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('shutting down'),
      expect.anything(),
    );
  });
});

