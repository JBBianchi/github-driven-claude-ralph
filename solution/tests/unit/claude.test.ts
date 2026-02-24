import { describe, it, expect, beforeEach, vi } from 'vitest';
import { execa } from 'execa';
import { invokeClaude } from '../../src/claude.js';
import type { ClaudeInvocation } from '../../src/types.js';

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

describe('invokeClaude', () => {
  beforeEach(() => {
    mockExeca.mockReset();
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

  it('measures duration in milliseconds', async () => {
    mockExeca.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { stdout: '{}', stderr: '', exitCode: 0 } as any;
    });

    const result = await invokeClaude(makeInvocation());

    expect(result.durationMs).toBeGreaterThanOrEqual(40);
  });
});
