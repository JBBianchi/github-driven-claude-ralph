import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { loadConfig } from '../../src/config.js';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  openSync: vi.fn(),
  closeSync: vi.fn(),
  unlinkSync: vi.fn(),
  statSync: vi.fn(),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

const mockMkdirSync = vi.mocked(mkdirSync);
const mockOpenSync = vi.mocked(openSync);
const mockCloseSync = vi.mocked(closeSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockStatSync = vi.mocked(statSync);
const mockReaddirSync = vi.mocked(readdirSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('loadConfig', () => {
  let originalEnv: NodeJS.ProcessEnv;

  const requiredEnv = {
    REPO_URL: 'https://github.com/org/repo.git',
    REPO_SLUG: 'org/repo',
    GH_TOKEN: 'ghp_test123',
    GIT_AUTHOR_NAME: 'Test Bot',
    GIT_AUTHOR_EMAIL: 'bot@test.com',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    originalEnv = { ...process.env };
    // Start with clean env for each test
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    // Set PATH so node can still run
    process.env.PATH = originalEnv.PATH;

    mockOpenSync.mockReturnValue(42);
    mockReadFileSync.mockImplementation(() => {
      throw errno('ENOENT');
    });
    mockReaddirSync.mockReturnValue([]);
    mockStatSync.mockImplementation(() => {
      throw errno('ENOENT');
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns valid config when all required env vars are present', () => {
    Object.assign(process.env, requiredEnv);
    const config = loadConfig('planner');

    expect(config.repoUrl).toBe('https://github.com/org/repo.git');
    expect(config.repoSlug).toBe('org/repo');
    expect(config.ghToken).toBe('ghp_test123');
    expect(config.gitAuthorName).toBe('Test Bot');
    expect(config.gitAuthorEmail).toBe('bot@test.com');
    expect(config.baseBranch).toBe('main');
    expect(config.gitCommitSigning).toBe('off');
    expect(config.role).toBe('planner');
    expect(config.agentProvider).toBe('claude');
    expect(config.agentModel).toBeUndefined();
    expect(config.claudeSubagentsEnabled).toBe(false);
  });

  it('applies planner defaults for pollIntervalSeconds and maxTurnsPerRun', () => {
    Object.assign(process.env, requiredEnv);
    const config = loadConfig('planner');

    expect(config.pollIntervalSeconds).toBe(120);
    expect(config.maxTurnsPerRun).toBe(50);
  });

  it('applies executor defaults for pollIntervalSeconds, maxTurnsPerRun, executorId', () => {
    Object.assign(process.env, requiredEnv);
    process.env.HOSTNAME = 'executor-instance-a';
    const config = loadConfig('executor');

    expect(config.pollIntervalSeconds).toBe(60);
    expect(config.maxTurnsPerRun).toBe(100);
    expect(config.executorId).toBe('executor-01');
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/workspace/state/executor/.instance-ids/executor-instance-a.id',
      'executor-01',
      'utf-8',
    );
  });

  it('reuses previously assigned executorId for the same instance key', () => {
    Object.assign(process.env, requiredEnv);
    process.env.HOSTNAME = 'executor-instance-a';
    mockReadFileSync.mockImplementation((path: string) => {
      if (path.endsWith('executor-instance-a.id')) {
        return 'executor-02';
      }
      throw errno('ENOENT');
    });

    const config = loadConfig('executor');

    expect(config.executorId).toBe('executor-02');
    expect(mockWriteFileSync).not.toHaveBeenCalled();
    expect(mockCloseSync).toHaveBeenCalledWith(42);
    expect(mockUnlinkSync).toHaveBeenCalledWith('/workspace/state/executor/.id-allocation.lock');
  });

  it('uses explicit EXECUTOR_ID without attempting auto-allocation', () => {
    Object.assign(process.env, requiredEnv, { EXECUTOR_ID: 'executor-07' });

    const config = loadConfig('executor');

    expect(config.executorId).toBe('executor-07');
    expect(mockOpenSync).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it('uses GITHUB_TOKEN when GH_TOKEN is not set', () => {
    const { GH_TOKEN, ...envWithoutGhToken } = requiredEnv;
    Object.assign(process.env, envWithoutGhToken, { GITHUB_TOKEN: 'ghp_fallback' });
    const config = loadConfig('planner');

    expect(config.ghToken).toBe('ghp_fallback');
  });

  it('throws when REPO_URL is missing', () => {
    const { REPO_URL, ...envWithout } = requiredEnv;
    Object.assign(process.env, envWithout);

    expect(() => loadConfig('planner')).toThrow(/REPO_URL/);
  });

  it('throws when REPO_SLUG is missing', () => {
    const { REPO_SLUG, ...envWithout } = requiredEnv;
    Object.assign(process.env, envWithout);

    expect(() => loadConfig('planner')).toThrow(/REPO_SLUG/);
  });

  it('throws when no GitHub token is provided', () => {
    const { GH_TOKEN, ...envWithout } = requiredEnv;
    Object.assign(process.env, envWithout);

    expect(() => loadConfig('planner')).toThrow(/token/i);
  });

  it('throws when GIT_AUTHOR_NAME is missing', () => {
    const { GIT_AUTHOR_NAME, ...envWithout } = requiredEnv;
    Object.assign(process.env, envWithout);

    expect(() => loadConfig('planner')).toThrow(/GIT_AUTHOR_NAME/);
  });

  it('throws when GIT_AUTHOR_EMAIL is missing', () => {
    const { GIT_AUTHOR_EMAIL, ...envWithout } = requiredEnv;
    Object.assign(process.env, envWithout);

    expect(() => loadConfig('planner')).toThrow(/GIT_AUTHOR_EMAIL/);
  });

  it('respects custom env var overrides', () => {
    Object.assign(process.env, requiredEnv, {
      BASE_BRANCH: 'develop',
      PLANNER_POLL_INTERVAL_SECONDS: '300',
      MAX_TURNS_PER_RUN: '15',
      GIT_COMMIT_SIGNING: 'gpg',
      GIT_SIGNING_KEY: 'ABC123',
      VALIDATION_COMMAND: 'npm test',
      EXECUTOR_ID: 'executor-05',
      SIGNING_KEYS_MOUNT: '/custom/keys',
    });
    const config = loadConfig('planner');

    expect(config.baseBranch).toBe('develop');
    expect(config.pollIntervalSeconds).toBe(300);
    expect(config.maxTurnsPerRun).toBe(15);
    expect(config.gitCommitSigning).toBe('gpg');
    expect(config.gitSigningKey).toBe('ABC123');
    expect(config.validationCommand).toBe('npm test');
    expect(config.signingKeysMount).toBe('/custom/keys');
  });

  it('uses PLANNER_MODEL over AGENT_MODEL and CLAUDE_MODEL for planner role', () => {
    Object.assign(process.env, requiredEnv, {
      AGENT_MODEL: 'agent-global',
      CLAUDE_MODEL: 'claude-global',
      PLANNER_MODEL: 'claude-planner',
    });

    const config = loadConfig('planner');

    expect(config.agentModel).toBe('claude-planner');
    expect(config.claudeModel).toBe('claude-planner');
  });

  it('falls back to AGENT_MODEL when PLANNER_MODEL is missing', () => {
    Object.assign(process.env, requiredEnv, {
      AGENT_MODEL: 'agent-global',
      CLAUDE_MODEL: 'claude-global',
    });

    const config = loadConfig('planner');

    expect(config.agentModel).toBe('agent-global');
    expect(config.claudeModel).toBe('agent-global');
  });

  it('falls back to CLAUDE_MODEL when AGENT_MODEL is missing', () => {
    Object.assign(process.env, requiredEnv, {
      CLAUDE_MODEL: 'claude-global',
    });

    const config = loadConfig('planner');

    expect(config.agentModel).toBe('claude-global');
    expect(config.claudeModel).toBe('claude-global');
  });

  it('uses EXECUTOR_MODEL over AGENT_MODEL and CLAUDE_MODEL for executor role', () => {
    Object.assign(process.env, requiredEnv, {
      AGENT_MODEL: 'agent-global',
      CLAUDE_MODEL: 'claude-global',
      EXECUTOR_MODEL: 'claude-executor',
    });

    const config = loadConfig('executor');

    expect(config.agentModel).toBe('claude-executor');
    expect(config.claudeModel).toBe('claude-executor');
  });

  it('falls back to AGENT_MODEL when EXECUTOR_MODEL is missing', () => {
    Object.assign(process.env, requiredEnv, {
      AGENT_MODEL: 'agent-global',
    });

    const config = loadConfig('executor');

    expect(config.agentModel).toBe('agent-global');
    expect(config.claudeModel).toBe('agent-global');
  });

  it('treats blank model values as unset', () => {
    Object.assign(process.env, requiredEnv, {
      AGENT_MODEL: '   ',
      CLAUDE_MODEL: '   ',
      PLANNER_MODEL: '\t',
    });

    const config = loadConfig('planner');

    expect(config.agentModel).toBeUndefined();
    expect(config.claudeModel).toBeUndefined();
  });

  it('defaults provider to claude when provider env vars are unset', () => {
    Object.assign(process.env, requiredEnv);

    const plannerConfig = loadConfig('planner');
    const executorConfig = loadConfig('executor');

    expect(plannerConfig.agentProvider).toBe('claude');
    expect(executorConfig.agentProvider).toBe('claude');
  });

  it('uses AGENT_PROVIDER when role-specific provider is missing', () => {
    Object.assign(process.env, requiredEnv, { AGENT_PROVIDER: 'codex' });

    const config = loadConfig('planner');

    expect(config.agentProvider).toBe('codex');
  });

  it('uses PLANNER_PROVIDER over AGENT_PROVIDER for planner role', () => {
    Object.assign(process.env, requiredEnv, {
      AGENT_PROVIDER: 'claude',
      PLANNER_PROVIDER: 'codex',
    });

    const config = loadConfig('planner');

    expect(config.agentProvider).toBe('codex');
  });

  it('uses EXECUTOR_PROVIDER over AGENT_PROVIDER for executor role', () => {
    Object.assign(process.env, requiredEnv, {
      AGENT_PROVIDER: 'claude',
      EXECUTOR_PROVIDER: 'codex',
    });

    const config = loadConfig('executor');

    expect(config.agentProvider).toBe('codex');
  });

  it('throws when AGENT_PROVIDER is invalid', () => {
    Object.assign(process.env, requiredEnv, { AGENT_PROVIDER: 'invalid-provider' });

    expect(() => loadConfig('planner')).toThrow(/claude or codex/);
  });

  it('throws on invalid GIT_COMMIT_SIGNING value', () => {
    Object.assign(process.env, requiredEnv, { GIT_COMMIT_SIGNING: 'invalid' });

    expect(() => loadConfig('planner')).toThrow(/off|gpg|ssh/i);
  });

  it('enables claudeSubagentsEnabled when CLAUDE_SUBAGENTS_ENABLED is "true"', () => {
    Object.assign(process.env, requiredEnv, { CLAUDE_SUBAGENTS_ENABLED: 'true' });

    const config = loadConfig('planner');

    expect(config.claudeSubagentsEnabled).toBe(true);
  });

  it('defaults autonomousMode to false when PLANNER_AUTONOMOUS_MODE is not set', () => {
    Object.assign(process.env, requiredEnv);
    const config = loadConfig('planner');
    expect(config.autonomousMode).toBe(false);
  });

  it('enables autonomousMode when PLANNER_AUTONOMOUS_MODE is "true"', () => {
    Object.assign(process.env, requiredEnv, { PLANNER_AUTONOMOUS_MODE: 'true' });
    const config = loadConfig('planner');
    expect(config.autonomousMode).toBe(true);
  });

  it('keeps autonomousMode disabled for non-"true" values', () => {
    Object.assign(process.env, requiredEnv, { PLANNER_AUTONOMOUS_MODE: 'yes' });
    const config = loadConfig('planner');
    expect(config.autonomousMode).toBe(false);
  });

  it('defaults autonomousMaxFeatures to 3', () => {
    Object.assign(process.env, requiredEnv);
    const config = loadConfig('planner');
    expect(config.autonomousMaxFeatures).toBe(3);
  });

  it('respects PLANNER_AUTONOMOUS_MAX_FEATURES override', () => {
    Object.assign(process.env, requiredEnv, { PLANNER_AUTONOMOUS_MAX_FEATURES: '5' });
    const config = loadConfig('planner');
    expect(config.autonomousMaxFeatures).toBe(5);
  });

  it('throws on invalid PLANNER_AUTONOMOUS_MAX_FEATURES', () => {
    Object.assign(process.env, requiredEnv, { PLANNER_AUTONOMOUS_MAX_FEATURES: 'abc' });
    expect(() => loadConfig('planner')).toThrow(/PLANNER_AUTONOMOUS_MAX_FEATURES/);
  });

  it('throws when PLANNER_AUTONOMOUS_MAX_FEATURES is zero', () => {
    Object.assign(process.env, requiredEnv, { PLANNER_AUTONOMOUS_MAX_FEATURES: '0' });
    expect(() => loadConfig('planner')).toThrow(/PLANNER_AUTONOMOUS_MAX_FEATURES/);
  });

  it('defaults autonomousFocus to empty string', () => {
    Object.assign(process.env, requiredEnv);
    const config = loadConfig('planner');
    expect(config.autonomousFocus).toBe('');
  });

  it('respects PLANNER_AUTONOMOUS_FOCUS override', () => {
    Object.assign(process.env, requiredEnv, { PLANNER_AUTONOMOUS_FOCUS: 'security' });
    const config = loadConfig('planner');
    expect(config.autonomousFocus).toBe('security');
  });

  it('defaults maxConcurrentPlans to 0', () => {
    Object.assign(process.env, requiredEnv);
    const config = loadConfig('planner');
    expect(config.maxConcurrentPlans).toBe(0);
  });

  it('respects PLANNER_MAX_CONCURRENT_PLANS override', () => {
    Object.assign(process.env, requiredEnv, { PLANNER_MAX_CONCURRENT_PLANS: '2' });
    const config = loadConfig('planner');
    expect(config.maxConcurrentPlans).toBe(2);
  });

  it('throws on invalid PLANNER_MAX_CONCURRENT_PLANS', () => {
    Object.assign(process.env, requiredEnv, { PLANNER_MAX_CONCURRENT_PLANS: 'abc' });
    expect(() => loadConfig('planner')).toThrow(/PLANNER_MAX_CONCURRENT_PLANS/);
  });

  it('throws when PLANNER_MAX_CONCURRENT_PLANS is negative', () => {
    Object.assign(process.env, requiredEnv, { PLANNER_MAX_CONCURRENT_PLANS: '-1' });
    expect(() => loadConfig('planner')).toThrow(/PLANNER_MAX_CONCURRENT_PLANS/);
  });
});
