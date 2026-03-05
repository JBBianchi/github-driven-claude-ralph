import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execa } from 'execa';
import { readFileSync, unlinkSync } from 'node:fs';
import { invokeCodex } from '../../src/codex.js';
import type { ClaudeInvocation, Logger } from '../../src/types.js';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(),
    unlinkSync: vi.fn(),
  };
});

const mockExeca = vi.mocked(execa);
const mockReadFileSync = vi.mocked(readFileSync);
const mockUnlinkSync = vi.mocked(unlinkSync);

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

describe('invokeCodex', () => {
  beforeEach(() => {
    mockExeca.mockReset();
    mockReadFileSync.mockReset();
    mockUnlinkSync.mockReset();
    mockReadFileSync.mockImplementation(() => 'final response');
  });

  it('invokes codex exec with json output and output-last-message path', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: '{"type":"thread.started","thread_id":"thread-1"}',
      stderr: '',
      exitCode: 0,
    } as any);

    await invokeCodex(makeInvocation());

    expect(mockExeca).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining([
        'exec',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
      ]),
      expect.objectContaining({ cwd: '/workspace/repo' }),
    );
    const args = mockExeca.mock.calls[0][1] as string[];
    expect(args).toContain('--output-last-message');
    expect(args).toContain('hello world');
  });

  it('uses resume command when resumeSessionId is provided', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: '{"type":"thread.started","thread_id":"thread-2"}',
      stderr: '',
      exitCode: 0,
    } as any);

    await invokeCodex(makeInvocation({ resumeSessionId: 'thread-old' }));

    const args = mockExeca.mock.calls[0][1] as string[];
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'thread-old']);
  });

  it('passes -m when model is configured', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: '{"type":"thread.started","thread_id":"thread-2"}',
      stderr: '',
      exitCode: 0,
    } as any);

    await invokeCodex(makeInvocation({ model: 'o3' }));

    const args = mockExeca.mock.calls[0][1] as string[];
    expect(args).toContain('-m');
    expect(args).toContain('o3');
  });

  it('prepends system prompt file content to the final prompt', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: '{"type":"thread.started","thread_id":"thread-3"}',
      stderr: '',
      exitCode: 0,
    } as any);

    mockReadFileSync.mockImplementation((path: string | Buffer | URL) => {
      if (String(path) === '/opt/agent/prompts/exec.md') {
        return 'SYSTEM PROMPT';
      }
      return 'final response';
    });

    await invokeCodex(makeInvocation({ systemPromptFile: '/opt/agent/prompts/exec.md' }));

    const args = mockExeca.mock.calls[0][1] as string[];
    const prompt = args[args.length - 1];
    expect(prompt).toContain('SYSTEM PROMPT');
    expect(prompt).toContain('hello world');
  });

  it('returns session id from thread.started event', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: '{"type":"thread.started","thread_id":"thread-xyz"}',
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await invokeCodex(makeInvocation());

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('thread-xyz');
    expect(result.result).toBe('final response');
  });

  it('returns success false when turn.failed is emitted', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: [
        '{"type":"thread.started","thread_id":"thread-xyz"}',
        '{"type":"turn.failed","error":{"message":"command failed"}}',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await invokeCodex(makeInvocation());

    expect(result.success).toBe(false);
    expect(result.sessionId).toBe('thread-xyz');
  });

  it('throws normalized auth error when output indicates missing login', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: '{"type":"error","message":"Not logged in"}',
      stderr: '',
      exitCode: 0,
    } as any);

    await expect(invokeCodex(makeInvocation())).rejects.toThrow('Agent authentication failed');
  });

  it('does not treat generic 401 runtime errors as fatal auth failures', async () => {
    mockExeca.mockResolvedValueOnce({
      stdout: [
        '{"type":"thread.started","thread_id":"thread-xyz"}',
        '{"type":"error","message":"Reconnecting... error sending request (401)"}',
        '{"type":"turn.failed","error":{"message":"stream disconnected"}}',
      ].join('\n'),
      stderr: '',
      exitCode: 0,
    } as any);

    const result = await invokeCodex(makeInvocation());

    expect(result.success).toBe(false);
    expect(result.sessionId).toBe('thread-xyz');
  });

  it('warns when Claude sub-agents are passed to codex invocation', async () => {
    const logger = makeLogger();
    mockExeca.mockResolvedValueOnce({
      stdout: '{"type":"thread.started","thread_id":"thread-1"}',
      stderr: '',
      exitCode: 0,
    } as any);

    await invokeCodex(makeInvocation({
      logger,
      agents: {
        helper: {
          description: 'test helper',
          prompt: 'do thing',
        },
      },
    }));

    expect(logger.warn).toHaveBeenCalledWith(
      'Codex invocation ignoring custom Claude sub-agents',
      expect.objectContaining({ activity: 'unspecified', agentCount: 1 }),
    );
  });
});
