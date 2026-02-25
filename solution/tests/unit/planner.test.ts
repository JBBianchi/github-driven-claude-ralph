import { describe, it, expect, beforeEach, vi } from 'vitest';
import { syncRepo } from '../../src/git.js';
import { listIssues, editIssueLabels, closeIssue, parseAgentMeta } from '../../src/github.js';
import { invokeClaude } from '../../src/claude.js';
import {
  runPlannerIteration,
  buildPlannerPrompt,
  buildTaskDecompPrompt,
} from '../../src/planner.js';
import type { Config, Logger, GitHubIssue } from '../../src/types.js';

vi.mock('../../src/git.js', () => ({
  syncRepo: vi.fn(),
}));

vi.mock('../../src/github.js', () => ({
  listIssues: vi.fn(),
  editIssueLabels: vi.fn(),
  closeIssue: vi.fn(),
  parseAgentMeta: vi.fn(),
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

describe('runPlannerIteration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockSyncRepo.mockResolvedValue(undefined);
    mockListIssues.mockResolvedValue([]);
    mockInvokeClaude.mockResolvedValue({ success: true, durationMs: 100 });
    mockEditIssueLabels.mockResolvedValue(undefined);
    mockCloseIssue.mockResolvedValue(undefined);
  });

  it('syncs repo at start of every iteration', async () => {
    const config = makeConfig();
    await runPlannerIteration(config, makeLogger());

    expect(mockSyncRepo).toHaveBeenCalledOnce();
    expect(mockSyncRepo).toHaveBeenCalledWith(config);
  });

  it('invokes Claude with plan prompt when features need plans', async () => {
    const feature = makeIssue({ number: 1, title: 'Add login' });
    // First listIssues call: features needing plans
    mockListIssues.mockResolvedValueOnce([feature]);
    // Second listIssues call: ready plans
    mockListIssues.mockResolvedValueOnce([]);

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockInvokeClaude).toHaveBeenCalledOnce();
    const call = mockInvokeClaude.mock.calls[0][0];
    expect(call.prompt).toContain('#1');
    expect(call.prompt).toContain('Add login');
    expect(call.systemPromptFile).toContain('plan.md');
  });

  it('skips Claude invocation when no features need plans', async () => {
    mockListIssues.mockResolvedValue([]);

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockInvokeClaude).not.toHaveBeenCalled();
  });

  it('invokes Claude with task decomp prompt when ready plans exist', async () => {
    const plan = makeIssue({
      number: 5,
      title: 'Plan: Add login',
      labels: ['plan:ready'],
    });
    // First call: features — none
    mockListIssues.mockResolvedValueOnce([]);
    // Second call: ready plans
    mockListIssues.mockResolvedValueOnce([plan]);

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockInvokeClaude).toHaveBeenCalledOnce();
    const call = mockInvokeClaude.mock.calls[0][0];
    expect(call.prompt).toContain('#5');
    expect(call.systemPromptFile).toContain('tasks.md');
  });

  it('skips plans that already have plan:tasks-created label', async () => {
    const plan = makeIssue({
      number: 5,
      title: 'Plan: Add login',
      labels: ['plan:ready', 'plan:tasks-created'],
    });
    mockListIssues.mockResolvedValueOnce([]);
    mockListIssues.mockResolvedValueOnce([plan]);

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockInvokeClaude).not.toHaveBeenCalled();
  });

  it('both phases run in same iteration when both have work', async () => {
    const feature = makeIssue({ number: 1, title: 'Feature A', labels: ['feature', 'needs-plan'] });
    const plan = makeIssue({ number: 5, title: 'Plan: A', labels: ['plan:ready'] });
    mockListIssues.mockResolvedValueOnce([feature]);
    mockListIssues.mockResolvedValueOnce([plan]);

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockInvokeClaude).toHaveBeenCalledTimes(2);
  });

  it('catches and logs Claude invocation failure', async () => {
    const feature = makeIssue();
    mockListIssues.mockResolvedValueOnce([feature]);
    mockListIssues.mockResolvedValueOnce([]);
    mockInvokeClaude.mockRejectedValueOnce(new Error('Claude crashed'));

    const logger = makeLogger();
    await runPlannerIteration(makeConfig(), logger);

    expect(logger.error).toHaveBeenCalled();
  });

  it('catches and logs syncRepo failure', async () => {
    mockSyncRepo.mockRejectedValueOnce(new Error('network down'));

    const logger = makeLogger();
    await runPlannerIteration(makeConfig(), logger);

    expect(logger.error).toHaveBeenCalled();
  });

  // --- Phase 3: Plan completion ---

  it('closes plan when all tasks are done', async () => {
    const plan = makeIssue({
      number: 5,
      title: 'Plan: Add login',
      labels: ['plan:tasks-created'],
    });
    // Phase 1: no features
    mockListIssues.mockResolvedValueOnce([]);
    // Phase 2: no ready plans
    mockListIssues.mockResolvedValueOnce([]);
    // Phase 3: one plan with tasks-created
    mockListIssues.mockResolvedValueOnce([plan]);
    // Phase 3: no open tasks
    mockListIssues.mockResolvedValueOnce([]);

    const logger = makeLogger();
    await runPlannerIteration(makeConfig(), logger);

    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(), 5, ['plan:done'], ['plan:tasks-created'],
    );
    expect(mockCloseIssue).toHaveBeenCalledWith(expect.anything(), 5);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Plan complete'),
      expect.objectContaining({ planNumber: 5 }),
    );
  });

  it('skips plan when open tasks remain for it', async () => {
    const plan = makeIssue({
      number: 5,
      title: 'Plan: Add login',
      labels: ['plan:tasks-created'],
    });
    const openTask = makeIssue({
      number: 99,
      title: 'Task: Implement login form',
      body: `<!-- agent-meta\nentity: task\nsource_feature: 1\nsource_plan: 5\n-->`,
      labels: ['task', 'todo'],
    });
    mockListIssues.mockResolvedValueOnce([]);
    mockListIssues.mockResolvedValueOnce([]);
    mockListIssues.mockResolvedValueOnce([plan]);
    mockListIssues.mockResolvedValueOnce([openTask]);
    mockParseAgentMeta.mockReturnValue({ entity: 'task', source_feature: 1, source_plan: 5 });

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockEditIssueLabels).not.toHaveBeenCalled();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it('ignores open tasks from other plans', async () => {
    const plan = makeIssue({
      number: 5,
      title: 'Plan: Add login',
      labels: ['plan:tasks-created'],
    });
    const unrelatedTask = makeIssue({
      number: 99,
      title: 'Task: Unrelated',
      body: `<!-- agent-meta\nentity: task\nsource_feature: 2\nsource_plan: 8\n-->`,
      labels: ['task', 'todo'],
    });
    mockListIssues.mockResolvedValueOnce([]);
    mockListIssues.mockResolvedValueOnce([]);
    mockListIssues.mockResolvedValueOnce([plan]);
    mockListIssues.mockResolvedValueOnce([unrelatedTask]);
    mockParseAgentMeta.mockReturnValue({ entity: 'task', source_feature: 2, source_plan: 8 });

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(), 5, ['plan:done'], ['plan:tasks-created'],
    );
    expect(mockCloseIssue).toHaveBeenCalledWith(expect.anything(), 5);
  });

  it('skips Phase 3 when no plans have plan:tasks-created', async () => {
    mockListIssues.mockResolvedValueOnce([]);
    mockListIssues.mockResolvedValueOnce([]);
    mockListIssues.mockResolvedValueOnce([]);

    await runPlannerIteration(makeConfig(), makeLogger());

    expect(mockEditIssueLabels).not.toHaveBeenCalled();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it('catches and logs Phase 3 errors', async () => {
    mockListIssues.mockResolvedValueOnce([]);
    mockListIssues.mockResolvedValueOnce([]);
    mockListIssues.mockRejectedValueOnce(new Error('API failure'));

    const logger = makeLogger();
    await runPlannerIteration(makeConfig(), logger);

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Phase 3'),
      expect.anything(),
    );
  });

  // --- Phase 3: Feature completion ---

  it('closes source feature when plan is completed', async () => {
    const plan = makeIssue({
      number: 5,
      title: 'Plan: Add login',
      body: `<!-- agent-meta\nentity: plan\nsource_feature: 1\n-->`,
      labels: ['plan:tasks-created'],
    });
    mockListIssues.mockResolvedValueOnce([]); // Phase 1
    mockListIssues.mockResolvedValueOnce([]); // Phase 2
    mockListIssues.mockResolvedValueOnce([plan]); // Phase 3: plans with tasks-created
    mockListIssues.mockResolvedValueOnce([]); // Phase 3: no open tasks
    mockParseAgentMeta.mockReturnValue({ entity: 'plan', source_feature: 1 });

    const logger = makeLogger();
    await runPlannerIteration(makeConfig(), logger);

    // Plan is closed
    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(), 5, ['plan:done'], ['plan:tasks-created'],
    );
    expect(mockCloseIssue).toHaveBeenCalledWith(expect.anything(), 5);
    // Feature is also closed
    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(), 1, ['done'], ['planned'],
    );
    expect(mockCloseIssue).toHaveBeenCalledWith(expect.anything(), 1);
  });

  it('does not close feature when plan body has no agent-meta', async () => {
    const plan = makeIssue({
      number: 5,
      title: 'Plan: Add login',
      body: 'Just a plain plan body',
      labels: ['plan:tasks-created'],
    });
    mockListIssues.mockResolvedValueOnce([]); // Phase 1
    mockListIssues.mockResolvedValueOnce([]); // Phase 2
    mockListIssues.mockResolvedValueOnce([plan]); // Phase 3: plans with tasks-created
    mockListIssues.mockResolvedValueOnce([]); // Phase 3: no open tasks
    mockParseAgentMeta.mockReturnValue(null);

    await runPlannerIteration(makeConfig(), makeLogger());

    // Plan is closed
    expect(mockEditIssueLabels).toHaveBeenCalledWith(
      expect.anything(), 5, ['plan:done'], ['plan:tasks-created'],
    );
    expect(mockCloseIssue).toHaveBeenCalledWith(expect.anything(), 5);
    // Feature is NOT closed (only 1 closeIssue call for the plan)
    expect(mockCloseIssue).toHaveBeenCalledTimes(1);
    expect(mockEditIssueLabels).toHaveBeenCalledTimes(1);
  });

  it('logs feature closure', async () => {
    const plan = makeIssue({
      number: 5,
      title: 'Plan: Add login',
      body: `<!-- agent-meta\nentity: plan\nsource_feature: 1\n-->`,
      labels: ['plan:tasks-created'],
    });
    mockListIssues.mockResolvedValueOnce([]); // Phase 1
    mockListIssues.mockResolvedValueOnce([]); // Phase 2
    mockListIssues.mockResolvedValueOnce([plan]); // Phase 3
    mockListIssues.mockResolvedValueOnce([]); // Phase 3: no open tasks
    mockParseAgentMeta.mockReturnValue({ entity: 'plan', source_feature: 1 });

    const logger = makeLogger();
    await runPlannerIteration(makeConfig(), logger);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Feature complete'),
      expect.objectContaining({ featureNumber: 1, planNumber: 5 }),
    );
  });
});

describe('buildPlannerPrompt', () => {
  it('includes all feature issue numbers and titles', () => {
    const features = [
      makeIssue({ number: 1, title: 'Feature A' }),
      makeIssue({ number: 2, title: 'Feature B' }),
    ];
    const config = makeConfig();

    const prompt = buildPlannerPrompt(config, features);

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
