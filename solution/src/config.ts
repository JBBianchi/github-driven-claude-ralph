import type { AgentProvider, Config, Role, SigningMode } from './types.js';
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
import { posix as pathPosix } from 'node:path';

const VALID_SIGNING_MODES: SigningMode[] = ['off', 'gpg', 'ssh'];
const VALID_AGENT_PROVIDERS: AgentProvider[] = ['claude', 'codex'];
const EXECUTOR_ID_PREFIX = 'executor-';
const EXECUTOR_ID_PADDING = 2;
const DEFAULT_EXECUTOR_ID = 'executor-01';
const EXECUTOR_STATE_ROOT = '/workspace/state/executor';
const EXECUTOR_INSTANCE_DIR = pathPosix.join(EXECUTOR_STATE_ROOT, '.instance-ids');
const EXECUTOR_ALLOCATION_LOCK = pathPosix.join(EXECUTOR_STATE_ROOT, '.id-allocation.lock');
const EXECUTOR_ALLOCATION_ATTEMPTS = 50;
const EXECUTOR_LOCK_STALE_MS = 30_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

function optionalTrimmedEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toErrnoError(error: unknown): NodeJS.ErrnoException | null {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return null;
  }
  return error as NodeJS.ErrnoException;
}

function isErrno(error: unknown, code: string): boolean {
  const errno = toErrnoError(error);
  return errno?.code === code;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function parseExecutorNumber(executorId: string): number | null {
  const match = /^executor-(\d+)$/.exec(executorId.trim());
  if (!match) {
    return null;
  }

  const number = parseInt(match[1], 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatExecutorId(number: number): string {
  return `${EXECUTOR_ID_PREFIX}${String(number).padStart(EXECUTOR_ID_PADDING, '0')}`;
}

function normalizedInstanceKey(raw: string): string {
  const sanitized = raw.trim().replace(/[^A-Za-z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'local';
}

function instanceMappingPath(instanceKey: string): string {
  return pathPosix.join(EXECUTOR_INSTANCE_DIR, `${instanceKey}.id`);
}

function readAssignedExecutorId(instanceKey: string): string | null {
  try {
    const raw = readFileSync(instanceMappingPath(instanceKey), 'utf-8').trim();
    const executorNumber = parseExecutorNumber(raw);
    if (executorNumber === null) {
      throw new Error(
        `Invalid executor ID mapping for instance "${instanceKey}": "${raw}"`,
      );
    }
    return formatExecutorId(executorNumber);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

function listAssignedExecutorNumbers(): Set<number> {
  const assigned = new Set<number>();
  let files: string[] = [];
  try {
    files = readdirSync(EXECUTOR_INSTANCE_DIR);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return assigned;
    }
    throw error;
  }

  for (const file of files) {
    if (!file.endsWith('.id')) {
      continue;
    }

    const path = pathPosix.join(EXECUTOR_INSTANCE_DIR, file);
    const raw = readFileSync(path, 'utf-8').trim();
    const executorNumber = parseExecutorNumber(raw);
    if (executorNumber === null) {
      throw new Error(`Invalid executor ID mapping in "${path}": "${raw}"`);
    }
    assigned.add(executorNumber);
  }

  return assigned;
}

function nextExecutorNumber(assigned: Set<number>): number {
  let candidate = 1;
  while (assigned.has(candidate)) {
    candidate += 1;
  }
  return candidate;
}

function clearStaleAllocationLock(): void {
  try {
    const lockStats = statSync(EXECUTOR_ALLOCATION_LOCK);
    if (Date.now() - lockStats.mtimeMs > EXECUTOR_LOCK_STALE_MS) {
      unlinkSync(EXECUTOR_ALLOCATION_LOCK);
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw new Error(`Failed to inspect executor ID lock: ${formatError(error)}`);
    }
  }
}

function withExecutorAllocationLock<T>(action: () => T): T {
  mkdirSync(EXECUTOR_STATE_ROOT, { recursive: true });

  for (let attempt = 0; attempt < EXECUTOR_ALLOCATION_ATTEMPTS; attempt += 1) {
    let lockFd: number | null = null;
    try {
      lockFd = openSync(EXECUTOR_ALLOCATION_LOCK, 'wx');
      return action();
    } catch (error) {
      if (isErrno(error, 'EEXIST')) {
        clearStaleAllocationLock();
        continue;
      }
      throw new Error(`Failed to allocate executor ID: ${formatError(error)}`);
    } finally {
      if (lockFd !== null) {
        closeSync(lockFd);
        try {
          unlinkSync(EXECUTOR_ALLOCATION_LOCK);
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) {
            throw new Error(`Failed to release executor ID lock: ${formatError(error)}`);
          }
        }
      }
    }
  }

  throw new Error('Failed to allocate executor ID: lock contention exceeded retry limit');
}

function allocateExecutorId(): string {
  const instanceKey = normalizedInstanceKey(
    process.env.EXECUTOR_INSTANCE_KEY || process.env.HOSTNAME || 'local',
  );

  return withExecutorAllocationLock(() => {
    mkdirSync(EXECUTOR_INSTANCE_DIR, { recursive: true });

    const existing = readAssignedExecutorId(instanceKey);
    if (existing) {
      return existing;
    }

    const assignedNumbers = listAssignedExecutorNumbers();
    const executorId = formatExecutorId(nextExecutorNumber(assignedNumbers));
    writeFileSync(instanceMappingPath(instanceKey), executorId, 'utf-8');
    return executorId;
  });
}

function resolveExecutorId(role: Role): string {
  const explicit = process.env.EXECUTOR_ID?.trim();
  if (explicit) {
    return explicit;
  }

  if (role !== 'executor') {
    return DEFAULT_EXECUTOR_ID;
  }

  return allocateExecutorId();
}

function resolveAgentProvider(role: Role): AgentProvider {
  const roleProvider = role === 'planner'
    ? optionalTrimmedEnv('PLANNER_PROVIDER')
    : optionalTrimmedEnv('EXECUTOR_PROVIDER');
  const provider = roleProvider ?? optionalTrimmedEnv('AGENT_PROVIDER') ?? 'claude';

  if (!VALID_AGENT_PROVIDERS.includes(provider as AgentProvider)) {
    throw new Error(
      `Invalid provider value: "${provider}". Expected: claude or codex`,
    );
  }

  return provider as AgentProvider;
}

function resolveAgentModel(role: Role): string | undefined {
  const roleModel = role === 'planner'
    ? optionalTrimmedEnv('PLANNER_MODEL')
    : optionalTrimmedEnv('EXECUTOR_MODEL');

  return roleModel ?? optionalTrimmedEnv('AGENT_MODEL') ?? optionalTrimmedEnv('CLAUDE_MODEL');
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

  const maxConcurrentPlans = process.env.PLANNER_MAX_CONCURRENT_PLANS
    ? parseInt(process.env.PLANNER_MAX_CONCURRENT_PLANS, 10)
    : 0;
  if (Number.isNaN(maxConcurrentPlans) || maxConcurrentPlans < 0) {
    throw new Error(
      `Invalid PLANNER_MAX_CONCURRENT_PLANS value: "${process.env.PLANNER_MAX_CONCURRENT_PLANS}". Expected a non-negative integer.`,
    );
  }

  const autonomousMaxFeatures = process.env.PLANNER_AUTONOMOUS_MAX_FEATURES
    ? parseInt(process.env.PLANNER_AUTONOMOUS_MAX_FEATURES, 10)
    : 3;
  if (Number.isNaN(autonomousMaxFeatures) || autonomousMaxFeatures < 1) {
    throw new Error(
      `Invalid PLANNER_AUTONOMOUS_MAX_FEATURES value: "${process.env.PLANNER_AUTONOMOUS_MAX_FEATURES}". Expected a positive integer.`,
    );
  }

  const agentModel = resolveAgentModel(role);

  return {
    role,
    repoUrl,
    repoSlug,
    baseBranch: process.env.BASE_BRANCH || 'main',
    ghToken,
    pollIntervalSeconds: pollOverride ? parseInt(pollOverride, 10) : pollDefault,
    executorId: resolveExecutorId(role),
    maxTurnsPerRun: process.env.MAX_TURNS_PER_RUN
      ? parseInt(process.env.MAX_TURNS_PER_RUN, 10)
      : maxTurnsDefault,
    gitCommitSigning: signingMode as SigningMode,
    gitSigningKey: process.env.GIT_SIGNING_KEY || '',
    signingKeysMount: process.env.SIGNING_KEYS_MOUNT || '/mnt/host-keys',
    validationCommand: process.env.VALIDATION_COMMAND || '',
    gitAuthorName,
    gitAuthorEmail,
    agentProvider: resolveAgentProvider(role),
    agentModel,
    claudeModel: agentModel,
    claudeSubagentsEnabled: process.env.CLAUDE_SUBAGENTS_ENABLED === 'true',
    autonomousMode: process.env.PLANNER_AUTONOMOUS_MODE === 'true',
    autonomousMaxFeatures,
    autonomousFocus: process.env.PLANNER_AUTONOMOUS_FOCUS ?? '',
    maxConcurrentPlans,
  };
}
