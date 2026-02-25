import type { Config, Role, SigningMode } from './types.js';

const VALID_SIGNING_MODES: SigningMode[] = ['off', 'gpg', 'ssh'];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

export function loadConfig(role: Role): Config {
  const repoUrl = requireEnv('REPO_URL');
  const repoSlug = requireEnv('REPO_SLUG');
  const gitAuthorName = requireEnv('GIT_AUTHOR_NAME');
  const gitAuthorEmail = requireEnv('GIT_AUTHOR_EMAIL');

  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!ghToken) {
    throw new Error('No GitHub token provided. Set GH_TOKEN or GITHUB_TOKEN.');
  }

  const signingMode = (process.env.GIT_COMMIT_SIGNING || 'off') as string;
  if (!VALID_SIGNING_MODES.includes(signingMode as SigningMode)) {
    throw new Error(
      `Invalid GIT_COMMIT_SIGNING value: "${signingMode}". Expected: off, gpg, or ssh`,
    );
  }

  const pollDefault = role === 'planner' ? 120 : 60;
  const maxTurnsDefault = role === 'planner' ? 50 : 100;

  const pollOverride =
    role === 'planner'
      ? process.env.PLANNER_POLL_INTERVAL_SECONDS
      : process.env.EXECUTOR_POLL_INTERVAL_SECONDS;

  return {
    role,
    repoUrl,
    repoSlug,
    baseBranch: process.env.BASE_BRANCH || 'main',
    ghToken,
    pollIntervalSeconds: pollOverride ? parseInt(pollOverride, 10) : pollDefault,
    executorId: process.env.EXECUTOR_ID || 'executor-01',
    maxTurnsPerRun: process.env.MAX_TURNS_PER_RUN
      ? parseInt(process.env.MAX_TURNS_PER_RUN, 10)
      : maxTurnsDefault,
    gitCommitSigning: signingMode as SigningMode,
    gitSigningKey: process.env.GIT_SIGNING_KEY || '',
    signingKeysMount: process.env.SIGNING_KEYS_MOUNT || '/mnt/host-keys',
    validationCommand: process.env.VALIDATION_COMMAND || '',
    gitAuthorName,
    gitAuthorEmail,
  };
}
