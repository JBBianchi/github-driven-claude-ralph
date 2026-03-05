import { execa } from 'execa';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { throwIfCodexAuthFailure } from './agent-auth.js';
import { appendToLog } from './log-files.js';
import type { ClaudeInvocation, ClaudeResult } from './types.js';

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const HEARTBEAT_MS = 30 * 1000;

interface CodexJsonEvent {
  type?: string;
  message?: string;
  thread_id?: string;
  error?: {
    message?: string;
  };
}

interface ParsedCodexOutput {
  sessionId?: string;
  hasFailure: boolean;
  errors: string[];
}

/**
 * Throws normalized Codex auth failure and appends raw context to Codex logs.
 *
 * @param rawMessage - Combined output/error text to inspect.
 */
function throwIfCodexAuthFailureWithLog(rawMessage: string): void {
  try {
    throwIfCodexAuthFailure(rawMessage);
  } catch (error: unknown) {
    appendToLog(
      'codex.log',
      `[${new Date().toISOString()}] AUTH FAILURE DETECTED\n${rawMessage.slice(0, 12_000)}\n===`,
    );
    throw error;
  }
}

/**
 * Returns the byte size of a streamed chunk.
 *
 * @param chunk - Streamed process output chunk.
 * @returns Chunk size in bytes.
 */
function getChunkByteLength(chunk: string | Uint8Array): number {
  return typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
}

/**
 * Prepends system prompt file content to the user prompt for providers that do not support
 * an explicit system prompt file flag.
 *
 * @param invocation - Provider invocation payload.
 * @returns Prompt string to send to the provider.
 */
function buildPrompt(invocation: ClaudeInvocation): string {
  if (!invocation.systemPromptFile) {
    return invocation.prompt;
  }

  const systemPrompt = readFileSync(invocation.systemPromptFile, 'utf-8');
  return `${systemPrompt.trim()}\n\n${invocation.prompt}`;
}

/**
 * Parses Codex JSONL event output.
 *
 * @param stdout - Raw stdout stream from `codex exec --json`.
 * @returns Structured extraction with session id and failure markers.
 */
function parseCodexOutput(stdout: string): ParsedCodexOutput {
  let sessionId: string | undefined;
  let hasFailure = false;
  const errors: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) {
      continue;
    }

    let event: CodexJsonEvent;
    try {
      event = JSON.parse(line) as CodexJsonEvent;
    } catch {
      continue;
    }

    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      sessionId = event.thread_id;
    }

    if (event.type === 'turn.failed') {
      hasFailure = true;
      if (typeof event.error?.message === 'string' && event.error.message.length > 0) {
        errors.push(event.error.message);
      }
    }

    if (event.type === 'error') {
      hasFailure = true;
      if (typeof event.message === 'string' && event.message.length > 0) {
        errors.push(event.message);
      }
    }
  }

  return { sessionId, hasFailure, errors };
}

/**
 * Reads and removes the Codex last-message output file when present.
 *
 * @param path - Temporary output file path.
 * @returns Message contents, or `undefined` when unavailable.
 */
function readLastMessage(path: string): string | undefined {
  try {
    const content = readFileSync(path, 'utf-8');
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // best-effort cleanup
    }
  }
}

/**
 * Invokes Codex CLI in non-interactive mode.
 *
 * @param invocation - Codex invocation payload.
 * @returns Normalized invocation result.
 */
export async function invokeCodex(invocation: ClaudeInvocation): Promise<ClaudeResult> {
  const outputPath = join(
    tmpdir(),
    `codex-last-message-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );
  const prompt = buildPrompt(invocation);
  const args = invocation.resumeSessionId
    ? ['exec', 'resume', invocation.resumeSessionId]
    : ['exec'];

  args.push('--json');
  args.push('--output-last-message', outputPath);
  args.push('--dangerously-bypass-approvals-and-sandbox');
  if (invocation.model) {
    args.push('-m', invocation.model);
  }
  args.push(prompt);

  const activity = invocation.activity ?? 'unspecified';
  if (invocation.maxTurns > 0) {
    invocation.logger?.warn('Codex invocation does not support maxTurns directly; timeout remains enforced', {
      activity,
      maxTurns: invocation.maxTurns,
    });
  }
  if (invocation.agents && Object.keys(invocation.agents).length > 0) {
    invocation.logger?.warn('Codex invocation ignoring custom Claude sub-agents', {
      activity,
      agentCount: Object.keys(invocation.agents).length,
    });
  }

  const start = Date.now();
  const ts = new Date().toISOString();
  let codexPid: number | null = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  appendToLog('codex.log', `[${ts}] INVOKE codex ${args.filter((a) => a !== prompt).join(' ')}\nPROMPT:\n${prompt}\n`);

  try {
    const subprocess = execa('codex', args, {
      cwd: invocation.workingDirectory,
      timeout: TIMEOUT_MS,
      stdin: 'ignore',
    });
    codexPid = subprocess.pid ?? null;

    subprocess.stdout?.on('data', (chunk: string | Uint8Array) => {
      stdoutBytes += getChunkByteLength(chunk);
    });
    subprocess.stderr?.on('data', (chunk: string | Uint8Array) => {
      stderrBytes += getChunkByteLength(chunk);
    });

    invocation.logger?.info('Codex invocation started', {
      activity,
      timeoutMs: TIMEOUT_MS,
      outputFormat: invocation.outputFormat,
      workingDirectory: invocation.workingDirectory,
      hasResumeSessionId: Boolean(invocation.resumeSessionId),
      codexPid,
    });

    heartbeatTimer = setInterval(() => {
      invocation.logger?.info('Codex invocation heartbeat', {
        activity,
        elapsedMs: Date.now() - start,
        timeoutMs: TIMEOUT_MS,
        codexPid,
        stdoutBytes,
        stderrBytes,
      });
    }, HEARTBEAT_MS);
    heartbeatTimer.unref();

    const { stdout, stderr } = await subprocess;
    const durationMs = Date.now() - start;
    const parsed = parseCodexOutput(stdout);
    const result = readLastMessage(outputPath) ?? stdout;
    const errors = parsed.errors.join('\n');

    throwIfCodexAuthFailureWithLog(`${stdout}\n${stderr}\n${errors}`);

    if (parsed.hasFailure) {
      invocation.logger?.warn('Codex invocation reported execution failure', {
        activity,
        durationMs,
        sessionId: parsed.sessionId ?? null,
        codexPid,
        stdoutBytes,
        stderrBytes,
      });
      appendToLog('codex.log', `[${new Date().toISOString()}] EXECUTION ERROR (${durationMs}ms)\n${stdout}\n===`);
      return { success: false, sessionId: parsed.sessionId, result, durationMs };
    }

    appendToLog('codex.log', `[${new Date().toISOString()}] SUCCESS (${durationMs}ms)\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr ?? '(none)'}\n===`);
    invocation.logger?.info('Codex invocation succeeded', {
      activity,
      durationMs,
      sessionId: parsed.sessionId ?? null,
      codexPid,
      stdoutBytes,
      stderrBytes,
    });
    return { success: true, sessionId: parsed.sessionId, result, durationMs };
  } catch (error: unknown) {
    const durationMs = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: string }).stderr ?? '';
    const stdout = (error as { stdout?: string }).stdout ?? '';

    invocation.logger?.warn('Codex invocation failed', {
      activity,
      durationMs,
      error: message,
      hasStderr: stderr.length > 0,
      codexPid,
      stdoutBytes,
      stderrBytes,
    });

    throwIfCodexAuthFailureWithLog(`${message}\n${stdout}\n${stderr}`);
    appendToLog('codex.log', `[${new Date().toISOString()}] FAILED (${durationMs}ms)\nERROR: ${message}\nSTDERR: ${stderr}\n===`);
    return {
      success: false,
      result: readLastMessage(outputPath) ?? stdout,
      durationMs,
    };
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
    // Ensure temporary file is not leaked when no earlier read happened.
    readLastMessage(outputPath);
  }
}
