import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/config.js';

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
    originalEnv = { ...process.env };
    // Start with clean env for each test
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    // Set PATH so node can still run
    process.env.PATH = originalEnv.PATH;
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
  });

  it('applies planner defaults for pollIntervalSeconds and maxTurnsPerRun', () => {
    Object.assign(process.env, requiredEnv);
    const config = loadConfig('planner');

    expect(config.pollIntervalSeconds).toBe(120);
    expect(config.maxTurnsPerRun).toBe(50);
  });

  it('applies executor defaults for pollIntervalSeconds, maxTurnsPerRun, executorId', () => {
    Object.assign(process.env, requiredEnv);
    const config = loadConfig('executor');

    expect(config.pollIntervalSeconds).toBe(60);
    expect(config.maxTurnsPerRun).toBe(100);
    expect(config.executorId).toBe('executor-01');
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

  it('throws on invalid GIT_COMMIT_SIGNING value', () => {
    Object.assign(process.env, requiredEnv, { GIT_COMMIT_SIGNING: 'invalid' });

    expect(() => loadConfig('planner')).toThrow(/off|gpg|ssh/i);
  });
});
