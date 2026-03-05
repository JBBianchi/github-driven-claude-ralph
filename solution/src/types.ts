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
  /** Optional Claude model override resolved from environment variables. */
  claudeModel?: string;
  /** Enables passing custom Claude sub-agent definitions to the CLI. */
  claudeSubagentsEnabled: boolean;
  /** Whether autonomous mode is enabled for the planner. */
  autonomousMode: boolean;
  /** Maximum features to create per autonomous analysis. */
  autonomousMaxFeatures: number;
  /** Optional focus area for autonomous analysis (empty = open-ended). */
  autonomousFocus: string;
  /** Max plans with status:todo tasks at once (0 = unlimited). */
  maxConcurrentPlans: number;
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

/**
 * Definition for a Claude sub-agent passed through `claude --agents`.
 */
export interface ClaudeSubagentDefinition {
  description: string;
  prompt: string;
}

/**
 * Named Claude sub-agent map passed through `claude --agents`.
 */
export type ClaudeSubagentMap = Record<string, ClaudeSubagentDefinition>;

export interface ClaudeInvocation {
  prompt: string;
  systemPromptFile?: string;
  maxTurns: number;
  outputFormat: 'text' | 'json';
  workingDirectory: string;
  /** Optional Claude model passed as `--model` when provided. */
  model?: string;
  /** Optional custom sub-agent definitions passed as `--agents` JSON. */
  agents?: ClaudeSubagentMap;
  resumeSessionId?: string;
  logger?: Logger;
  activity?: string;
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

/**
 * Machine-readable claim outcome reason.
 */
export type ClaimFailureReason =
  | 'lost-race'
  | 'missing-claim-label'
  | 'missing-in-progress-label';

/**
 * Result of a task claim attempt.
 */
export interface ClaimAttempt {
  taskId: number;
  nonce: string;
  success: boolean;
  reason?: ClaimFailureReason;
  ownerExecutorId?: string;
}

export interface Logger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}
