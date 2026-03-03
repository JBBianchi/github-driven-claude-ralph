import { execa } from 'execa';
import { readFileSync, readdirSync } from 'node:fs';
import { appendToLog } from './log-files.js';
import type { ClaudeInvocation, ClaudeResult } from './types.js';

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const HEARTBEAT_MS = 30 * 1000;
/** Kill the subprocess after this many consecutive heartbeats with no progress. */
const STALL_HEARTBEAT_LIMIT = 10; // 10 × 30s = 5 minutes
const CLAUDE_AUTH_FAILURE_PREFIX = 'Claude authentication failed:';
const MAX_PROCESS_SNAPSHOT_ENTRIES = 6;
const PROCESS_CMDLINE_PREVIEW_CHARS = 140;

interface ProcessInfo {
  pid: number;
  ppid: number;
  state: string;
  cmdline: string;
}

/**
 * Returns the byte size of a streamed chunk.
 *
 * @param chunk Streamed process output chunk.
 * @returns Chunk size in bytes.
 */
function getChunkByteLength(chunk: string | Uint8Array): number {
  return typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
}

/**
 * Parses Linux `/proc/<pid>/stat` contents.
 *
 * @param statRaw Raw `stat` file contents.
 * @returns Parent PID and process state, or `null` when parsing fails.
 */
function parseLinuxProcStat(statRaw: string): { ppid: number; state: string } | null {
  const closeParenIndex = statRaw.lastIndexOf(')');
  if (closeParenIndex < 0) {
    return null;
  }

  const tail = statRaw.slice(closeParenIndex + 2).trim();
  const parts = tail.split(/\s+/);
  if (parts.length < 2) {
    return null;
  }

  const state = parts[0];
  const ppid = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(ppid)) {
    return null;
  }

  return { ppid, state };
}

/**
 * Reads process details from Linux `/proc`.
 *
 * @param pid Process ID.
 * @returns Parsed process info, or `null` when unavailable.
 */
function readLinuxProcessInfo(pid: number): ProcessInfo | null {
  try {
    const statRaw = readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const parsed = parseLinuxProcStat(statRaw);
    if (!parsed) {
      return null;
    }

    const cmdlineRaw = readFileSync(`/proc/${pid}/cmdline`);
    const cmdline = cmdlineRaw
      .toString('utf-8')
      .replace(/\0+/g, ' ')
      .trim();

    return {
      pid,
      ppid: parsed.ppid,
      state: parsed.state,
      cmdline: cmdline || '[empty-cmdline]',
    };
  } catch {
    return null;
  }
}

/**
 * Builds a descendant process snapshot for a root PID on Linux.
 *
 * @param rootPid Root process ID.
 * @returns Human-readable descendant summary or `null` when unavailable.
 */
function buildLinuxProcessSnapshot(rootPid: number): string | null {
  try {
    const allPids = readdirSync('/proc')
      .map((entry) => Number.parseInt(entry, 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0);

    const byParent = new Map<number, ProcessInfo[]>();
    for (const pid of allPids) {
      const info = readLinuxProcessInfo(pid);
      if (!info) {
        continue;
      }

      const siblings = byParent.get(info.ppid);
      if (siblings) {
        siblings.push(info);
      } else {
        byParent.set(info.ppid, [info]);
      }
    }

    const descendants: ProcessInfo[] = [];
    const queue: number[] = [rootPid];
    const visited = new Set<number>(queue);

    while (queue.length > 0 && descendants.length < MAX_PROCESS_SNAPSHOT_ENTRIES) {
      const currentPid = queue.shift()!;
      const children = byParent.get(currentPid) ?? [];
      for (const child of children) {
        if (visited.has(child.pid)) {
          continue;
        }
        visited.add(child.pid);
        descendants.push(child);
        queue.push(child.pid);
        if (descendants.length >= MAX_PROCESS_SNAPSHOT_ENTRIES) {
          break;
        }
      }
    }

    if (descendants.length === 0) {
      return null;
    }

    return descendants
      .map((processInfo) => {
        const cmdlinePreview = processInfo.cmdline.length > PROCESS_CMDLINE_PREVIEW_CHARS
          ? `${processInfo.cmdline.slice(0, PROCESS_CMDLINE_PREVIEW_CHARS)}...`
          : processInfo.cmdline;
        return `pid=${processInfo.pid} state=${processInfo.state} cmd="${cmdlinePreview}"`;
      })
      .join(' | ');
  } catch {
    return null;
  }
}

function isClaudeAuthFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('failed to authenticate')
    || normalized.includes('authentication_error')
    || normalized.includes('oauth token has expired')
    || normalized.includes('please obtain a new token')
    || normalized.includes('401')
  );
}

function getAuthFailureMessage(message: string): string {
  if (message.includes('OAuth token has expired')) {
    return `${CLAUDE_AUTH_FAILURE_PREFIX} OAuth token has expired.`;
  }
  return `${CLAUDE_AUTH_FAILURE_PREFIX} API credentials are invalid or expired.`;
}

function throwIfClaudeAuthFailure(rawMessage: string): void {
  if (isClaudeAuthFailure(rawMessage)) {
    throw new Error(getAuthFailureMessage(rawMessage));
  }
}

export async function invokeClaude(invocation: ClaudeInvocation): Promise<ClaudeResult> {
  // Always use JSON output internally for structured error reporting.
  // Extract text result for callers that requested 'text' format.
  const args = [
    '-p', invocation.prompt,
    '--dangerously-skip-permissions',
    '--max-turns', String(invocation.maxTurns),
    '--output-format', 'json',
    '--verbose',
  ];

  if (invocation.systemPromptFile) {
    args.push('--append-system-prompt-file', invocation.systemPromptFile);
  }

  if (invocation.resumeSessionId) {
    args.push('--resume', invocation.resumeSessionId);
  }

  const start = Date.now();
  const ts = new Date().toISOString();
  const activity = invocation.activity ?? 'unspecified';
  let claudePid: number | null = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let lastStdoutBytes = 0;
  let lastStderrBytes = 0;
  let lastProcessSnapshot: string | null = null;
  let staleHeartbeats = 0;

  appendToLog('claude.log', `[${ts}] INVOKE claude ${args.filter((a) => a !== invocation.prompt).join(' ')}\nPROMPT:\n${invocation.prompt}\n`);

  try {
    const subprocess = execa('claude', args, {
      cwd: invocation.workingDirectory,
      timeout: TIMEOUT_MS,
      stdin: 'ignore',
    });
    claudePid = subprocess.pid ?? null;

    subprocess.stdout?.on('data', (chunk: string | Uint8Array) => {
      stdoutBytes += getChunkByteLength(chunk);
    });
    subprocess.stderr?.on('data', (chunk: string | Uint8Array) => {
      stderrBytes += getChunkByteLength(chunk);
    });

    invocation.logger?.info('Claude invocation started', {
      activity,
      timeoutMs: TIMEOUT_MS,
      maxTurns: invocation.maxTurns,
      outputFormat: invocation.outputFormat,
      workingDirectory: invocation.workingDirectory,
      hasResumeSessionId: Boolean(invocation.resumeSessionId),
      claudePid,
    });
    appendToLog(
      'claude.log',
      `[${new Date().toISOString()}] STARTED activity=${activity} pid=${claudePid ?? 'unknown'} timeoutMs=${TIMEOUT_MS}`,
    );

    heartbeatTimer = setInterval(() => {
      const elapsedMs = Date.now() - start;
      const processSnapshot = claudePid ? buildLinuxProcessSnapshot(claudePid) : null;

      // Stall detection: kill subprocess if nothing has changed for too long.
      const hasProgress =
        stdoutBytes !== lastStdoutBytes
        || stderrBytes !== lastStderrBytes
        || processSnapshot !== lastProcessSnapshot;

      if (hasProgress) {
        staleHeartbeats = 0;
      } else {
        staleHeartbeats += 1;
      }
      lastStdoutBytes = stdoutBytes;
      lastStderrBytes = stderrBytes;
      lastProcessSnapshot = processSnapshot;

      invocation.logger?.info('Claude invocation heartbeat', {
        activity,
        elapsedMs,
        timeoutMs: TIMEOUT_MS,
        claudePid,
        stdoutBytes,
        stderrBytes,
        staleHeartbeats,
        processSnapshot,
      });
      appendToLog(
        'claude.log',
        `[${new Date().toISOString()}] HEARTBEAT activity=${activity} pid=${claudePid ?? 'unknown'} elapsedMs=${elapsedMs} timeoutMs=${TIMEOUT_MS} stdoutBytes=${stdoutBytes} stderrBytes=${stderrBytes} stale=${staleHeartbeats}/${STALL_HEARTBEAT_LIMIT}${processSnapshot ? ` processSnapshot=${processSnapshot}` : ''}`,
      );

      if (staleHeartbeats >= STALL_HEARTBEAT_LIMIT) {
        invocation.logger?.warn('Claude invocation stalled — killing subprocess', {
          activity,
          elapsedMs,
          staleHeartbeats,
          claudePid,
          stdoutBytes,
          stderrBytes,
          processSnapshot,
        });
        appendToLog(
          'claude.log',
          `[${new Date().toISOString()}] STALL DETECTED activity=${activity} pid=${claudePid ?? 'unknown'} stale=${staleHeartbeats} — sending SIGTERM`,
        );
        subprocess.kill('SIGTERM');
      }
    }, HEARTBEAT_MS);
    heartbeatTimer.unref();

    const { stdout, stderr } = await subprocess;

    const durationMs = Date.now() - start;
    if (stderr) console.error(stderr);

    let sessionId: string | undefined;
    let result: string = stdout;
    let success = true;

    try {
      const parsed = JSON.parse(stdout);
      sessionId = parsed.session_id;

      // Check for execution errors in the JSON response
      if (parsed.is_error || parsed.subtype === 'error_during_execution') {
        throwIfClaudeAuthFailure(stdout);
        success = false;
        const errors = parsed.errors?.join('\n') ?? 'Unknown error';
        console.error(`[claude] execution error: ${errors}`);
        invocation.logger?.warn('Claude invocation execution error', {
          activity,
          durationMs,
          sessionId: sessionId ?? null,
          errors,
          claudePid,
          stdoutBytes,
          stderrBytes,
        });
        appendToLog('claude.log', `[${new Date().toISOString()}] EXECUTION ERROR (${durationMs}ms)\n${stdout}\n===`);
        return { success: false, sessionId, durationMs };
      }

      // For callers expecting text, extract the result field
      if (invocation.outputFormat === 'text' && parsed.result !== undefined) {
        result = parsed.result;
      }
    } catch (parseError: unknown) {
      if (!(parseError instanceof SyntaxError)) {
        throw parseError;
      }
      // Not valid JSON - use raw stdout as result
    }

    appendToLog('claude.log', `[${new Date().toISOString()}] SUCCESS (${durationMs}ms)\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr ?? '(none)'}\n===`);
    invocation.logger?.info('Claude invocation succeeded', {
      activity,
      durationMs,
      sessionId: sessionId ?? null,
      claudePid,
      stdoutBytes,
      stderrBytes,
    });

    return { success, sessionId, result, durationMs };
  } catch (error: unknown) {
    const durationMs = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    const stderr = (error as { stderr?: string }).stderr ?? '';
    invocation.logger?.warn('Claude invocation failed', {
      activity,
      durationMs,
      error: message,
      hasStderr: stderr.length > 0,
      claudePid,
      stdoutBytes,
      stderrBytes,
    });
    throwIfClaudeAuthFailure(`${message}\n${stderr}`);
    console.error(`[claude] invocation failed (${durationMs}ms): ${message}`);
    if (stderr) console.error(`[claude] stderr: ${stderr}`);
    appendToLog('claude.log', `[${new Date().toISOString()}] FAILED (${durationMs}ms)\nERROR: ${message}\nSTDERR: ${stderr}\n===`);
    return { success: false, durationMs };
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  }
}
