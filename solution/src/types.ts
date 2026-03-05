export type Role = 'planner' | 'executor';
export type SigningMode = 'off' | 'gpg' | 'ssh';
export type AgentProvider = 'claude' | 'codex';

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
  /** Selected agent CLI provider for this role. */
  agentProvider: AgentProvider;
  /** Optional model override resolved from environment variables. */
  agentModel?: string;
  /** Legacy alias mirrored from `agentModel` for backward compatibility. */
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

/**
 * Provider-neutral invocation payload for agent CLI adapters.
 */
export interface AgentInvocation {
  provider: AgentProvider;
  prompt: string;
  systemPromptFile?: string;
  maxTurns: number;
  outputFormat: 'text' | 'json';
  workingDirectory: string;
  /** Optional model passed to the selected provider when supported. */
  model?: string;
  /** Optional custom Claude sub-agent definitions passed as `--agents` JSON. */
  agents?: ClaudeSubagentMap;
  resumeSessionId?: string;
  logger?: Logger;
  activity?: string;
}

/**
 * Result returned by an agent CLI adapter invocation.
 */
export interface AgentResult {
  success: boolean;
  sessionId?: string;
  result?: string;
  durationMs: number;
}

/**
 * Claude adapter invocation payload.
 */
export type ClaudeInvocation = Omit<AgentInvocation, 'provider'>;

/**
 * Claude adapter result payload.
 */
export type ClaudeResult = AgentResult;

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
