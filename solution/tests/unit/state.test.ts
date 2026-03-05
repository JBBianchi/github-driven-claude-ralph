import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import {
  readExecutorState,
  writeExecutorState,
  clearActiveTask,
  recoverStateFromGitHub,
} from '../../src/state.js';
import { listIssues } from '../../src/github.js';
import type { Config } from '../../src/types.js';

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  existsSync: vi.fn(),
}));

vi.mock('../../src/github.js', () => ({
  listIssues: vi.fn(),
}));

const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockExistsSync = vi.mocked(existsSync);
const mockListIssues = vi.mocked(listIssues);

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
    agentProvider: 'claude',
    agentModel: undefined,
    claudeModel: undefined,
    claudeSubagentsEnabled: false,
    autonomousMode: false,
    autonomousMaxFeatures: 3,
    autonomousFocus: '',
    maxConcurrentPlans: 0,
    ...overrides,
  };
}

describe('readExecutorState', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns parsed state from file', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{"activeTaskId":42,"sessionId":"sess-1"}');

    const state = readExecutorState('executor-01');

    expect(state).toEqual({ activeTaskId: 42, sessionId: 'sess-1', consecutiveFailures: 0 });
  });

  it('returns null when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);

    const state = readExecutorState('executor-01');

    expect(state).toBeNull();
  });

  it('returns null when file contains invalid JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('corrupt data');

    const state = readExecutorState('executor-01');

    expect(state).toBeNull();
  });

  it('reads from correct path: /workspace/state/executor/<id>/state.json', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('{"activeTaskId":null,"sessionId":null}');

    readExecutorState('executor-03');

    expect(mockExistsSync).toHaveBeenCalledWith(
      '/workspace/state/executor/executor-03/state.json',
    );
    expect(mockReadFileSync).toHaveBeenCalledWith(
      '/workspace/state/executor/executor-03/state.json',
      'utf-8',
    );
  });
});

describe('writeExecutorState', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('writes JSON to correct path', () => {
    writeExecutorState('executor-01', { activeTaskId: 42, sessionId: 'sess-1' });

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/workspace/state/executor/executor-01/state.json',
      '{"activeTaskId":42,"sessionId":"sess-1"}',
      'utf-8',
    );
  });

  it('creates parent directories if missing', () => {
    writeExecutorState('executor-01', { activeTaskId: 42, sessionId: null });

    expect(mockMkdirSync).toHaveBeenCalledWith(
      '/workspace/state/executor/executor-01',
      { recursive: true },
    );
  });
});

describe('clearActiveTask', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('writes state with null activeTaskId and null sessionId', () => {
    clearActiveTask('executor-01');

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/workspace/state/executor/executor-01/state.json',
      '{"activeTaskId":null,"sessionId":null,"consecutiveFailures":0}',
      'utf-8',
    );
  });
});

describe('recoverStateFromGitHub', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns state with active task when claimed issue found', async () => {
    mockListIssues.mockResolvedValueOnce([
      { number: 42, title: 'Task', body: '', labels: ['status:in-progress', 'claimed-by:executor-01'], state: 'OPEN' },
    ]);

    const state = await recoverStateFromGitHub(makeConfig());

    expect(state).toEqual({ activeTaskId: 42, sessionId: null, consecutiveFailures: 0 });
  });

  it('returns empty state when no claimed issues found', async () => {
    mockListIssues.mockResolvedValueOnce([]);

    const state = await recoverStateFromGitHub(makeConfig());

    expect(state).toEqual({ activeTaskId: null, sessionId: null, consecutiveFailures: 0 });
  });

  it('uses config.executorId to construct claimed-by label', async () => {
    mockListIssues.mockResolvedValueOnce([]);

    await recoverStateFromGitHub(makeConfig({ executorId: 'executor-05' }));

    expect(mockListIssues).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['claimed-by:executor-05']),
    );
  });
});

