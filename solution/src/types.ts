export type Role = 'planner' | 'executor';
export type SigningMode = 'off' | 'gpg' | 'ssh';

export interface Config {
  role: Role;
  repoUrl: string;
  repoSlug: string;
  baseBranch: string;
  ghToken: string;
  pollIntervalSeconds: number;
  executorId: string;
  maxTurnsPerRun: number;
  gitCommitSigning: SigningMode;
  gitSigningKey: string;
  signingKeysMount: string;
  validationCommand: string;
  gitAuthorName: string;
  gitAuthorEmail: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'OPEN' | 'CLOSED';
  updatedAt?: string;
}

export interface GitHubPR {
  number: number;
  title: string;
  headBranch: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  reviewDecision: string | null;
  checksStatus: ChecksStatus;
}

export type ChecksStatus = 'passing' | 'failing' | 'pending';
export type PRStatus = 'mergeable' | 'failing' | 'pending' | 'conflicting';

export interface AgentMeta {
  entity: 'plan' | 'task';
  source_feature: number;
  source_plan?: number;
  depends_on?: number[];
  executor_id?: string;
  branch?: string;
  pr?: number;
}

export interface ClaudeInvocation {
  prompt: string;
  systemPromptFile?: string;
  maxTurns: number;
  outputFormat: 'text' | 'json';
  workingDirectory: string;
  resumeSessionId?: string;
}

export interface ClaudeResult {
  success: boolean;
  sessionId?: string;
  result?: string;
  durationMs: number;
}

export interface ExecutorState {
  activeTaskId: number | null;
  sessionId: string | null;
  consecutiveFailures?: number;
}

export interface ClaimAttempt {
  taskId: number;
  nonce: string;
  success: boolean;
}

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}
