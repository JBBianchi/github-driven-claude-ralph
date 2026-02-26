import { describe, it, expect, beforeEach, vi } from 'vitest';
import { syncRepo } from '../../src/git.js';
import { listIssues, editIssueLabels, closeIssue, parseAgentMeta, addComment } from '../../src/github.js';
import { invokeClaude } from '../../src/claude.js';
import {
  runPlannerIteration,
  buildPlannerPrompt,
  buildTaskDecompPrompt,
} from '../../src/planner.js';
import type { Config, Logger, GitHubIssue, AgentMeta } from '../../src/types.js';

vi.mock('../../src/git.js', () => ({
  syncRepo: vi.fn(),
}));

vi.mock('../../src/github.js', () => ({
  listIssues: vi.fn(),
  editIssueLabels: vi.fn(),
  closeIssue: vi.fn(),
  parseAgentMeta: vi.fn(),
  addComment: vi.fn(),
}));

vi.mock('../../src/claude.js', () => ({
  invokeClaude: vi.fn(),
}));

const mockSyncRepo = vi.mocked(syncRepo);
const mockListIssues = vi.mocked(listIssues);
const mockInvokeClaude = vi.mocked(invokeClaude);
const mockEditIssueLabels = vi.mocked(editIssueLabels);
const mockCloseIssue = vi.mocked(closeIssue);
const mockParseAgentMeta = vi.mocked(parseAgentMeta);
const mockAddComment = vi.mocked(addComment);

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    role: 'planner',
    repoUrl: 'https://github.com/org/repo.git',
    repoSlug: 'org/repo',
    baseBranch: 'main',
    ghToken: 'ghp_test',
    pollIntervalSeconds: 120,
    executorId: 'executor-01',
    maxTurnsPerRun: 30,
    gitCommitSigning: 'off',
    gitSigningKey: '',
    signingKeysMount: '/mnt/host-keys',
    validationCommand: '',
    gitAuthorName: 'Bot',
    gitAuthorEmail: 'bot@test.com',
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: 'Feature A',
    body: 'Description',
    labels: ['feature', 'needs-plan'],
    state: 'OPEN',
    ...overrides,
  };
}

function setListIssuesMap(
  values: Record<string, GitHubIssue[]>,
): void {
  mockListIssues.mockImplementation(
    async (_config, labels: string[], state: 'open' | 'closed' | 'all' = 'open') => values[`${state}|${labels.join(',')}`] ?? [],
  );
}

describe('runPlannerIteration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSyncRepo.mockResolvedValue(undefined);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockEditIssueLabels.mockResolvedValue(undefined);
    mockCloseIssue.mockResolvedValue(undefined);
    mockAddComment.mockResolvedValue(undefined);
    setListIssuesMap({});
    mockParseAgentMeta.mockReturnValue(null);
  });

  it('syncs repo at start of every iteration', async () => {
    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockSyncRepo).toHaveBeenCalledOnce();
  });

  it('invokes Claude for plan creation when features need plans', async () => {
    const feature = makeIssue({ number: 1, title: 'Add login' });
    setListIssuesMap({
      'open|feature,needs-plan': [feature],
    });

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockInvokeClaude).toHaveBeenCalledWith(
      expect.objectContaining({ systemPromptFile: expect.stringContaining('plan.md') }),
    );
  });

  it('rethrows fatal Claude authentication failures', async () => {
    const feature = makeIssue({ number: 1, title: 'Add login' });
    setListIssuesMap({
      'open|feature,needs-plan': [feature],
    });
    mockInvokeClaude.mockRejectedValue(new Error('Claude authentication failed: OAuth token has expired.'));

    await expect(runPlannerIteration(makeConfig(), makeLogger())).rejects.toThrow('Claude authentication failed');
  });

  it('invokes Claude for task decomposition when ready plans exist', async () => {
    const plan = makeIssue({
      number: 5,
      title: 'Plan: Add login',
      labels: ['plan:ready'],
    });
    setListIssuesMap({
      'open|plan:ready': [plan],
    });

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockInvokeClaude).toHaveBeenCalledWith(
      expect.objectContaining({ systemPromptFile: expect.stringContaining('tasks.md') }),
    );
  });

  it('promotes waiting task to todo when dependencies are done', async () => {
    const waitingTask = makeIssue({
      number: 99,
      title: 'Task: B',
      labels: ['task', 'status:waiting'],
      body: 'task-b',
    });
    const doneTask = makeIssue({ number: 98, labels: ['task', 'status:done'] });

    setListIssuesMap({
      'open|task': [waitingTask],
      'all|task,status:done': [doneTask],
    });
    mockParseAgentMeta.mockImplementation((body): AgentMeta | null => {
      if (body === 'task-b') {
        return { entity: 'task', source_feature: 1, source_plan: 5, depends_on: [98] };
      }
      return null;
    });

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(),
      99,
      ['status:todo'],
      ['status:waiting'],
    );
  });

  it('moves todo task to waiting when dependencies are unresolved', async () => {
    const todoTask = makeIssue({
      number: 100,
      title: 'Task: C',
      labels: ['task', 'status:todo'],
      body: 'task-c',
    });
    setListIssuesMap({
      'open|task': [todoTask],
      'all|task,status:done': [],
    });
    mockParseAgentMeta.mockImplementation((body): AgentMeta | null => {
      if (body === 'task-c') {
        return { entity: 'task', source_feature: 1, source_plan: 5, depends_on: [77] };
      }
      return null;
    });

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(),
      100,
      ['status:waiting'],
      ['status:todo'],
    );
  });

  it('adds stale waiting comment when unresolved dependencies persist', async () => {
    const staleWaitingTask = makeIssue({
      number: 101,
      title: 'Task: D',
      labels: ['task', 'status:waiting'],
      body: 'task-d',
      updatedAt: '2026-02-20T00:00:00Z',
    });
    setListIssuesMap({
      'open|task': [staleWaitingTask],
      'all|task,status:done': [],
    });
    mockParseAgentMeta.mockImplementation((body): AgentMeta | null => {
      if (body === 'task-d') {
        return { entity: 'task', source_feature: 1, source_plan: 5, depends_on: [55, 56] };
      }
      return null;
    });

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockAddComment).toHaveBeenCalledWith(
      expect.anything(),
      101,
      expect.stringContaining('#55, #56'),
    );
  });

  it('closes plan when all of its tasks are done', async () => {
    const plan = makeIssue({
      number: 5,
      title: 'Plan: Add login',
      body: 'plan-body',
      labels: ['plan:tasks-created'],
    });
    setListIssuesMap({
      'open|plan:tasks-created': [plan],
    });
    mockParseAgentMeta.mockImplementation((body): AgentMeta | null => {
      if (body === 'plan-body') {
        return { entity: 'plan', source_feature: 1 };
      }
      return null;
    });

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(),
      5,
      ['plan:done'],
      ['plan:tasks-created'],
    );
    expect(mockCloseIssue).toHaveBeenCalledWith(expect.anything(), 5);
  });

  it('closes source feature with status:done when plan is completed', async () => {
    const plan = makeIssue({
      number: 5,
      title: 'Plan: Add login',
      body: 'plan-with-feature',
      labels: ['plan:tasks-created'],
    });
    setListIssuesMap({
      'open|plan:tasks-created': [plan],
    });
    mockParseAgentMeta.mockImplementation((body): AgentMeta | null => {
      if (body === 'plan-with-feature') {
        return { entity: 'plan', source_feature: 1 };
      }
      return null;
    });

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(),
      1,
      ['status:done'],
      ['planned'],
    );
    expect(mockCloseIssue).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('logs scheduling phase errors without throwing', async () => {
    mockListIssues.mockImplementation(async (_config, labels: string[]) => {
      if (labels.join(',') === 'task') {
        throw new Error('API failure');
      }
      return [];
    });

    const logger = makeLogger();
    await runPlannerIteration(makeConfig(), logger);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Phase 3'),
      expect.anything(),
    );
  });
});

describe('buildPlannerPrompt', () => {
  it('includes all feature issue numbers and titles', () => {
    const features = [
      makeIssue({ number: 1, title: 'Feature A' }),
      makeIssue({ number: 2, title: 'Feature B' }),
    ];

    const prompt = buildPlannerPrompt(makeConfig(), features);

    expect(prompt).toContain('#1: Feature A');
    expect(prompt).toContain('#2: Feature B');
  });

  it('includes repo slug', () => {
    const prompt = buildPlannerPrompt(makeConfig(), [makeIssue()]);
    expect(prompt).toContain('org/repo');
  });
});

describe('buildTaskDecompPrompt', () => {
  it('includes plan issue references', () => {
    const plans = [
      makeIssue({ number: 5, title: 'Plan: Add login' }),
      makeIssue({ number: 6, title: 'Plan: Add auth' }),
    ];

    const prompt = buildTaskDecompPrompt(makeConfig(), plans);

    expect(prompt).toContain('#5: Plan: Add login');
    expect(prompt).toContain('#6: Plan: Add auth');
  });
});
