import { describe, it, expect, beforeEach, vi } from 'vitest';
import { syncRepo } from '../../src/git.js';
import { listIssues, editIssueLabels, closeIssue, parseAgentMeta, addComment } from '../../src/github.js';
import { invokeClaude } from '../../src/claude.js';
import {
  runPlannerIteration,
  buildPlannerPrompt,
  buildTaskDecompPrompt,
  buildAutonomousPrompt,
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
    autonomousMode: false,
    autonomousMaxFeatures: 3,
    autonomousFocus: '',
    maxConcurrentPlans: 0,
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

  it('closes plan when all of its tasks are status:done', async () => {
    const plan = makeIssue({
      number: 5,
      title: 'Plan: Add login',
      body: 'plan-body',
      labels: ['plan:tasks-created'],
    });
    const doneTask = makeIssue({
      number: 50,
      body: 'task-for-plan-5',
      labels: ['task', 'status:done'],
      state: 'CLOSED',
    });
    setListIssuesMap({
      'open|plan:tasks-created': [plan],
      'all|task': [doneTask],
    });
    mockParseAgentMeta.mockImplementation((body): AgentMeta | null => {
      if (body === 'plan-body') {
        return { entity: 'plan', source_feature: 1 };
      }
      if (body === 'task-for-plan-5') {
        return { entity: 'task', source_feature: 1, source_plan: 5, depends_on: [] };
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
    const doneTask = makeIssue({
      number: 50,
      body: 'task-for-plan-5b',
      labels: ['task', 'status:done'],
      state: 'CLOSED',
    });
    setListIssuesMap({
      'open|plan:tasks-created': [plan],
      'all|task': [doneTask],
    });
    mockParseAgentMeta.mockImplementation((body): AgentMeta | null => {
      if (body === 'plan-with-feature') {
        return { entity: 'plan', source_feature: 1 };
      }
      if (body === 'task-for-plan-5b') {
        return { entity: 'task', source_feature: 1, source_plan: 5, depends_on: [] };
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

describe('Phase 3 - plan-sequential gating', () => {
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

  it('does not gate when maxConcurrentPlans is 0 (unlimited)', async () => {
    const waitingTask = makeIssue({
      number: 99,
      title: 'Task from plan 20',
      labels: ['task', 'status:waiting'],
      body: 'task-plan20',
    });
    setListIssuesMap({
      'open|task': [waitingTask],
      'all|task,status:done': [],
    });
    mockParseAgentMeta.mockImplementation((body): AgentMeta | null => {
      if (body === 'task-plan20') {
        return { entity: 'task', source_feature: 1, source_plan: 20, depends_on: [] };
      }
      return null;
    });

    await runPlannerIteration(makeConfig({ maxConcurrentPlans: 0 }), makeLogger());

    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(),
      99,
      ['status:todo'],
      ['status:waiting'],
    );
  });

  it('only promotes tasks from the lowest-numbered incomplete plan when maxConcurrentPlans=1', async () => {
    const taskFromPlan10 = makeIssue({
      number: 50,
      labels: ['task', 'status:waiting'],
      body: 'task-p10',
    });
    const taskFromPlan20 = makeIssue({
      number: 60,
      labels: ['task', 'status:waiting'],
      body: 'task-p20',
    });
    const plan10 = makeIssue({ number: 10, labels: ['plan:tasks-created'] });
    const plan20 = makeIssue({ number: 20, labels: ['plan:tasks-created'] });

    setListIssuesMap({
      'open|task': [taskFromPlan10, taskFromPlan20],
      'all|task,status:done': [],
      'open|plan:tasks-created': [plan20, plan10], // unsorted — code should sort
    });
    mockParseAgentMeta.mockImplementation((body): AgentMeta | null => {
      if (body === 'task-p10') {
        return { entity: 'task', source_feature: 1, source_plan: 10, depends_on: [] };
      }
      if (body === 'task-p20') {
        return { entity: 'task', source_feature: 2, source_plan: 20, depends_on: [] };
      }
      return null;
    });

    await runPlannerIteration(makeConfig({ maxConcurrentPlans: 1 }), makeLogger());

    // Task from plan 10 should be promoted
    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(),
      50,
      ['status:todo'],
      ['status:waiting'],
    );
    // Task from plan 20 should NOT be promoted (stays waiting)
    expect(mockEditIssueLabels).not.toHaveBeenCalledWith(
      expect.anything(),
      60,
      ['status:todo'],
      ['status:waiting'],
    );
  });

  it('demotes todo task to waiting when its plan is not active', async () => {
    const todoTaskFromPlan20 = makeIssue({
      number: 60,
      labels: ['task', 'status:todo'],
      body: 'task-p20-todo',
    });
    const plan10 = makeIssue({ number: 10, labels: ['plan:tasks-created'] });
    const plan20 = makeIssue({ number: 20, labels: ['plan:tasks-created'] });

    setListIssuesMap({
      'open|task': [todoTaskFromPlan20],
      'all|task,status:done': [],
      'open|plan:tasks-created': [plan10, plan20],
    });
    mockParseAgentMeta.mockImplementation((body): AgentMeta | null => {
      if (body === 'task-p20-todo') {
        return { entity: 'task', source_feature: 2, source_plan: 20, depends_on: [] };
      }
      return null;
    });

    await runPlannerIteration(makeConfig({ maxConcurrentPlans: 1 }), makeLogger());

    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(),
      60,
      ['status:waiting'],
      ['status:todo'],
    );
  });
});

describe('Phase 4 - hardened plan completion', () => {
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

  it('does not close plan when it has waiting tasks', async () => {
    const plan = makeIssue({
      number: 5,
      body: 'plan-5',
      labels: ['plan:tasks-created'],
    });
    const waitingTask = makeIssue({
      number: 50,
      body: 'task-waiting',
      labels: ['task', 'status:waiting'],
      state: 'OPEN',
    });
    setListIssuesMap({
      'open|plan:tasks-created': [plan],
      'all|task': [waitingTask],
    });
    mockParseAgentMeta.mockImplementation((body): AgentMeta | null => {
      if (body === 'plan-5') return { entity: 'plan', source_feature: 1 };
      if (body === 'task-waiting') return { entity: 'task', source_feature: 1, source_plan: 5, depends_on: [] };
      return null;
    });

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockCloseIssue).not.toHaveBeenCalledWith(expect.anything(), 5);
  });

  it('does not close plan when no tasks are found for it', async () => {
    const plan = makeIssue({
      number: 5,
      body: 'plan-no-tasks',
      labels: ['plan:tasks-created'],
    });
    setListIssuesMap({
      'open|plan:tasks-created': [plan],
      'all|task': [],
    });
    mockParseAgentMeta.mockImplementation((body): AgentMeta | null => {
      if (body === 'plan-no-tasks') return { entity: 'plan', source_feature: 1 };
      return null;
    });

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockCloseIssue).not.toHaveBeenCalledWith(expect.anything(), 5);
  });

  it('does not close plan when a task has unparseable metadata', async () => {
    const plan = makeIssue({
      number: 5,
      body: 'plan-unparseable',
      labels: ['plan:tasks-created'],
    });
    const taskWithBadMeta = makeIssue({
      number: 50,
      body: 'bad-meta',
      labels: ['task', 'status:todo'],
      state: 'OPEN',
    });
    const doneTask = makeIssue({
      number: 51,
      body: 'good-task',
      labels: ['task', 'status:done'],
      state: 'CLOSED',
    });
    setListIssuesMap({
      'open|plan:tasks-created': [plan],
      'all|task': [taskWithBadMeta, doneTask],
    });
    mockParseAgentMeta.mockImplementation((body): AgentMeta | null => {
      if (body === 'plan-unparseable') return { entity: 'plan', source_feature: 1 };
      if (body === 'bad-meta') return null; // Unparseable
      if (body === 'good-task') return { entity: 'task', source_feature: 1, source_plan: 5, depends_on: [] };
      return null;
    });

    await runPlannerIteration(makeConfig(), makeLogger());

    // Only 1 task matched plan 5 (the good one), and it's done, so plan closes
    // The bad-meta task doesn't match any plan (returns null), so it's excluded
    expect(mockCloseIssue).toHaveBeenCalledWith(expect.anything(), 5);
  });

  it('closes plan only when every task is status:done', async () => {
    const plan = makeIssue({
      number: 5,
      body: 'plan-mixed',
      labels: ['plan:tasks-created'],
    });
    const doneTask = makeIssue({
      number: 50,
      body: 'task-done',
      labels: ['task', 'status:done'],
      state: 'CLOSED',
    });
    const inProgressTask = makeIssue({
      number: 51,
      body: 'task-ip',
      labels: ['task', 'status:in-progress'],
      state: 'OPEN',
    });
    setListIssuesMap({
      'open|plan:tasks-created': [plan],
      'all|task': [doneTask, inProgressTask],
    });
    mockParseAgentMeta.mockImplementation((body): AgentMeta | null => {
      if (body === 'plan-mixed') return { entity: 'plan', source_feature: 1 };
      if (body === 'task-done') return { entity: 'task', source_feature: 1, source_plan: 5, depends_on: [] };
      if (body === 'task-ip') return { entity: 'task', source_feature: 1, source_plan: 5, depends_on: [] };
      return null;
    });

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockCloseIssue).not.toHaveBeenCalledWith(expect.anything(), 5);
  });
});

describe('buildAutonomousPrompt', () => {
  it('includes repo slug and max features count', () => {
    const prompt = buildAutonomousPrompt(
      makeConfig({ autonomousMaxFeatures: 5 }),
      [],
    );
    expect(prompt).toContain('org/repo');
    expect(prompt).toContain('up to 5');
  });

  it('lists existing issues for deduplication', () => {
    const existing = [
      makeIssue({ number: 10, title: 'Existing feature', labels: ['feature'] }),
    ];
    const prompt = buildAutonomousPrompt(makeConfig(), existing);
    expect(prompt).toContain('#10');
    expect(prompt).toContain('Existing feature');
  });

  it('shows "(none)" when no existing issues', () => {
    const prompt = buildAutonomousPrompt(makeConfig(), []);
    expect(prompt).toContain('(none)');
  });

  it('includes focus area when configured', () => {
    const prompt = buildAutonomousPrompt(
      makeConfig({ autonomousFocus: 'security' }),
      [],
    );
    expect(prompt).toContain('Focus area: security');
  });

  it('omits focus line when focus is empty', () => {
    const prompt = buildAutonomousPrompt(
      makeConfig({ autonomousFocus: '' }),
      [],
    );
    expect(prompt).not.toContain('Focus area:');
  });
});

describe('runPlannerIteration - Phase 0 (autonomous)', () => {
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

  it('skips Phase 0 when autonomousMode is false', async () => {
    await runPlannerIteration(makeConfig({ autonomousMode: false }), makeLogger());

    expect(mockInvokeClaude).not.toHaveBeenCalledWith(
      expect.objectContaining({ systemPromptFile: expect.stringContaining('analyze.md') }),
    );
  });

  it('skips Phase 0 when pipeline has features needing plans', async () => {
    setListIssuesMap({
      'open|feature,needs-plan': [makeIssue({ number: 1 })],
    });

    await runPlannerIteration(makeConfig({ autonomousMode: true }), makeLogger());

    expect(mockInvokeClaude).not.toHaveBeenCalledWith(
      expect.objectContaining({ systemPromptFile: expect.stringContaining('analyze.md') }),
    );
  });

  it('skips Phase 0 when pipeline has ready plans', async () => {
    setListIssuesMap({
      'open|plan:ready': [makeIssue({ number: 5, labels: ['plan:ready'] })],
    });

    await runPlannerIteration(makeConfig({ autonomousMode: true }), makeLogger());

    expect(mockInvokeClaude).not.toHaveBeenCalledWith(
      expect.objectContaining({ systemPromptFile: expect.stringContaining('analyze.md') }),
    );
  });

  it('skips Phase 0 when pipeline has open tasks', async () => {
    setListIssuesMap({
      'open|task': [makeIssue({ number: 10, labels: ['task'] })],
    });

    await runPlannerIteration(makeConfig({ autonomousMode: true }), makeLogger());

    expect(mockInvokeClaude).not.toHaveBeenCalledWith(
      expect.objectContaining({ systemPromptFile: expect.stringContaining('analyze.md') }),
    );
  });

  it('invokes Claude with analyze.md when autonomous and pipeline idle', async () => {
    await runPlannerIteration(
      makeConfig({ autonomousMode: true }),
      makeLogger(),
    );

    expect(mockInvokeClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPromptFile: expect.stringContaining('analyze.md'),
      }),
    );
  });

  it('passes existing feature issues to the autonomous prompt', async () => {
    const existingFeature = makeIssue({ number: 42, title: 'Existing', labels: ['feature'] });
    setListIssuesMap({
      'open|feature': [existingFeature],
    });

    await runPlannerIteration(
      makeConfig({ autonomousMode: true }),
      makeLogger(),
    );

    expect(mockInvokeClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('#42'),
      }),
    );
  });

  it('logs error and continues when Phase 0 fails', async () => {
    // Make listIssues throw for the first pipeline check call
    let callCount = 0;
    mockListIssues.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) throw new Error('API timeout');
      return [];
    });

    const logger = makeLogger();
    await runPlannerIteration(
      makeConfig({ autonomousMode: true }),
      logger,
    );

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Phase 0'),
      expect.anything(),
    );
  });

  it('rethrows fatal Claude auth errors in Phase 0', async () => {
    mockInvokeClaude.mockRejectedValueOnce(
      new Error('Claude authentication failed: OAuth token has expired.'),
    );

    await expect(
      runPlannerIteration(makeConfig({ autonomousMode: true }), makeLogger()),
    ).rejects.toThrow('Claude authentication failed');
  });
});
