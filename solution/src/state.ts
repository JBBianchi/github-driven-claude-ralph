import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { listIssues } from './github.js';
import { LABELS, claimedByLabel } from './labels.js';
import type { Config, ExecutorState } from './types.js';

const STATE_BASE = '/workspace/state/executor';

function statePath(executorId: string): string {
  return `${STATE_BASE}/${executorId}/state.json`;
}

function stateDir(executorId: string): string {
  return `${STATE_BASE}/${executorId}`;
}

export function readExecutorState(executorId: string): ExecutorState | null {
  const path = statePath(executorId);
  if (!existsSync(path)) {
    return null;
  }

  try {
    const data = readFileSync(path, 'utf-8');
    const raw = JSON.parse(data) as Record<string, unknown>;
    return {
      activeTaskId: (raw.activeTaskId as number | null) ?? null,
      sessionId: (raw.sessionId as string | null) ?? null,
      consecutiveFailures: (raw.consecutiveFailures as number) ?? 0,
    };
  } catch {
    return null;
  }
}

export function writeExecutorState(executorId: string, state: ExecutorState): void {
  const dir = stateDir(executorId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(statePath(executorId), JSON.stringify(state), 'utf-8');
}

export function clearActiveTask(executorId: string): void {
  writeExecutorState(executorId, { activeTaskId: null, sessionId: null, consecutiveFailures: 0 });
}

export async function recoverStateFromGitHub(config: Config): Promise<ExecutorState> {
  const claimedBy = claimedByLabel(config.executorId);
  const issues = await listIssues(config, [LABELS.statusInProgress, claimedBy]);

  if (issues.length > 0) {
    return { activeTaskId: issues[0].number, sessionId: null, consecutiveFailures: 0 };
  }

  return { activeTaskId: null, sessionId: null, consecutiveFailures: 0 };
}
