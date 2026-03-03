import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execa } from 'execa';
import { PassThrough } from 'node:stream';
import { invokeClaude } from '../../src/claude.js';
import type { ClaudeInvocation, Logger } from '../../src/types.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const mockExeca = vi.mocked(execa);

function makeInvocation(overrides: Partial<ClaudeInvocation> = {}): ClaudeInvocation {
  return {
    prompt: 'hello world',
    maxTurns: 10,
    outputFormat: 'text',
    workingDirectory: '/workspace/repo',
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('invokeClaude', () => {
  beforeEach(() => {
    mockExeca.mockReset();
    vi.useRealTimers();
  });

  it('always uses json output format internally', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 } as any);

    await invokeClaude(makeInvocation());

    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining([
        '-p', 'hello world',
        '--dangerously-skip-permissions',
        '--max-turns', '10',
        '--output-format', 'json',
        '--verbose',
      ]),
      expect.objectContaining({ cwd: '/workspace/repo' }),
    );
  });

  it('appends --append-system-prompt-file when systemPromptFile is set', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 } as any);

    await invokeClaude(makeInvocation({ systemPromptFile: '/opt/agent/prompts/exec.md' }));

    const args = mockExeca.mock.calls[0][1] as string[];
    expect(args).toContain('--append-system-prompt-file');
    expect(args).toContain('/opt/agent/prompts/exec.md');
  });

  it('appends --resume when resumeSessionId is set', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 } as any);

    await invokeClaude(makeInvocation({ resumeSessionId: 'sess-abc-123' }));

    const args = mockExeca.mock.calls[0][1] as string[];
    expect(args).toContain('--resume');
    expect(args).toContain('sess-abc-123');
  });

  it('extracts text result from JSON response when outputFormat is text', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ result: 'some output', session_id: 'sess-1' }),
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await invokeClaude(makeInvocation());

    expect(result.success).toBe(true);
    expect(result.result).toBe('some output');
    expect(result.durationMs).toBeTypeOf('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('parses session_id from JSON output', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({ session_id: 'sess-xyz', result: 'done' }),
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await invokeClaude(makeInvocation({ outputFormat: 'json' }));

    expect(result.sessionId).toBe('sess-xyz');
  });

  it('returns success:false when process exits with non-zero code', async () => {
    const error = new Error('Process failed') as any;
    error.exitCode = 1;
    error.stderr = 'error msg';
    error.stdout = '';
    mockExeca.mockRejectedValueOnce(error);

    const result = await invokeClaude(makeInvocation());

    expect(result.success).toBe(false);
    expect(result.durationMs).toBeTypeOf('number');
  });

  it('throws when process output indicates expired authentication token', async () => {
    const error = new Error('Failed to authenticate. API Error: 401 authentication_error OAuth token has expired.') as any;
    error.exitCode = 1;
    error.stderr = '';
    error.stdout = '';
    mockExeca.mockRejectedValueOnce(error);

    await expect(invokeClaude(makeInvocation())).rejects.toThrow('Claude authentication failed');
  });

  it('sets 30-minute timeout', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 } as any);

    await invokeClaude(makeInvocation());

    expect(mockExeca).toHaveBeenCalledWith(
      'claude',
      expect.any(Array),
      expect.objectContaining({ timeout: 1800000 }),
    );
  });

  it('handles malformed JSON in json output mode gracefully', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: 'not valid json',
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await invokeClaude(makeInvocation({ outputFormat: 'json' }));

    expect(result.success).toBe(true);
    expect(result.result).toBe('not valid json');
    expect(result.sessionId).toBeUndefined();
  });

  it('detects execution errors in JSON response', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        is_error: true,
        subtype: 'error_during_execution',
        session_id: 'sess-err',
        errors: ['ENOENT: missing file'],
      }),
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await invokeClaude(makeInvocation());

    expect(result.success).toBe(false);
    expect(result.sessionId).toBe('sess-err');
  });

  it('throws when JSON execution error indicates authentication failure', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: JSON.stringify({
        is_error: true,
        subtype: 'error_during_execution',
        session_id: 'sess-auth',
        errors: ['authentication_error: OAuth token has expired'],
      }),
      stderr: '',
      exitCode: 0,
    } as any);

    await expect(invokeClaude(makeInvocation())).rejects.toThrow('Claude authentication failed');
  });

  it('measures duration in milliseconds', async () => {
    mockExeca.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { stdout: '{}', stderr: '', exitCode: 0 } as any;
    });

    const result = await invokeClaude(makeInvocation());

    expect(result.durationMs).toBeGreaterThanOrEqual(40);
  });

  it('logs lifecycle messages when logger is provided', async () => {
    const logger = makeLogger();
    mockExeca.mockResolvedValueOnce({ stdout: '{}', stderr: '', exitCode: 0 } as any);

    await invokeClaude(makeInvocation({ logger, activity: 'executor-implementation' }));

    expect(logger.info).toHaveBeenCalledWith(
      'Claude invocation started',
      expect.objectContaining({
        activity: 'executor-implementation',
        timeoutMs: 1800000,
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Claude invocation succeeded',
      expect.objectContaining({
        activity: 'executor-implementation',
        durationMs: expect.any(Number),
      }),
    );
  });

  it('logs heartbeat messages for long-running invocation', async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    mockExeca.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 65000));
      return { stdout: '{}', stderr: '', exitCode: 0 } as any;
    });

    const pending = invokeClaude(makeInvocation({ logger, activity: 'review' }));
    await vi.advanceTimersByTimeAsync(70000);
    await pending;

    expect(logger.info).toHaveBeenCalledWith(
      'Claude invocation heartbeat',
      expect.objectContaining({ activity: 'review' }),
    );
  });

  it('kills subprocess after consecutive stale heartbeats', async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const killFn = vi.fn();

    let rejectProcess: ((reason: Error) => void) | null = null;
    const completion = new Promise<{ stdout: string; stderr: string; exitCode: number }>((_resolve, reject) => {
      rejectProcess = reject;
    });

    const subprocess = Object.assign(completion, {
      pid: 9999,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: killFn,
    });
    mockExeca.mockReturnValueOnce(subprocess as any);

    const pending = invokeClaude(makeInvocation({ logger, activity: 'stuck-task' }));

    // Advance through 10 stale heartbeats (10 × 30s = 300s)
    // The first heartbeat at 30s is never stale (first observation), so we need 11 intervals.
    await vi.advanceTimersByTimeAsync(11 * 30_000);

    expect(killFn).toHaveBeenCalledWith('SIGTERM');
    expect(logger.warn).toHaveBeenCalledWith(
      'Claude invocation stalled — killing subprocess',
      expect.objectContaining({
        activity: 'stuck-task',
        claudePid: 9999,
      }),
    );

    // Clean up: reject the promise so invokeClaude finishes
    const error = new Error('killed') as any;
    error.stderr = '';
    rejectProcess?.(error);
    subprocess.stdout.end();
    subprocess.stderr.end();
    await pending;
  });

  it('resets stale counter when process snapshot changes', async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const killFn = vi.fn();
    const stdoutStream = new PassThrough();

    let resolveProcess: ((value: { stdout: string; stderr: string; exitCode: number }) => void) | null = null;
    const completion = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      resolveProcess = resolve;
    });

    const subprocess = Object.assign(completion, {
      pid: 8888,
      stdout: stdoutStream,
      stderr: new PassThrough(),
      kill: killFn,
    });
    mockExeca.mockReturnValueOnce(subprocess as any);

    const pending = invokeClaude(makeInvocation({ logger, activity: 'progressing-task' }));

    // Advance 8 stale heartbeats (just under the limit of 10)
    await vi.advanceTimersByTimeAsync(9 * 30_000);
    expect(killFn).not.toHaveBeenCalled();

    // Write some output to reset the stale counter
    stdoutStream.write('progress');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(killFn).not.toHaveBeenCalled();

    // Advance another 8 stale heartbeats — still under limit since counter reset
    await vi.advanceTimersByTimeAsync(8 * 30_000);
    expect(killFn).not.toHaveBeenCalled();

    // Clean up
    resolveProcess?.({ stdout: '{}', stderr: '', exitCode: 0 });
    stdoutStream.end();
    subprocess.stderr.end();
    await pending;
  });

  it('tracks streamed stdout/stderr byte counters in heartbeat logs', async () => {
    vi.useFakeTimers();
    const logger = makeLogger();
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    let resolveProcess: ((value: { stdout: string; stderr: string; exitCode: number }) => void) | null = null;
    const completion = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      resolveProcess = resolve;
    });

    const subprocess = Object.assign(completion, {
      pid: 4321,
      stdout: stdoutStream,
      stderr: stderrStream,
    });
    mockExeca.mockReturnValueOnce(subprocess as any);

    const pending = invokeClaude(makeInvocation({ logger, activity: 'executor-implementation' }));
    stdoutStream.write('hello');
    stderrStream.write('oops');

    await vi.advanceTimersByTimeAsync(31_000);
    resolveProcess?.({ stdout: '{}', stderr: '', exitCode: 0 });
    stdoutStream.end();
    stderrStream.end();
    await pending;

    expect(logger.info).toHaveBeenCalledWith(
      'Claude invocation heartbeat',
      expect.objectContaining({
        activity: 'executor-implementation',
        claudePid: 4321,
        stdoutBytes: 5,
        stderrBytes: 4,
      }),
    );
  });
});
