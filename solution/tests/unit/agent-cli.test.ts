import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invokeClaude } from '../../src/claude.js';
import { invokeCodex } from '../../src/codex.js';
import { invokeAgent } from '../../src/agent-cli.js';
import type { AgentInvocation } from '../../src/types.js';

vi.mock('../../src/claude.js', () => ({
  invokeClaude: vi.fn(),
}));

vi.mock('../../src/codex.js', () => ({
  invokeCodex: vi.fn(),
}));

const mockInvokeClaude = vi.mocked(invokeClaude);
const mockInvokeCodex = vi.mocked(invokeCodex);

function makeInvocation(overrides: Partial<AgentInvocation> = {}): AgentInvocation {
  return {
    provider: 'claude',
    prompt: 'hello world',
    maxTurns: 10,
    outputFormat: 'text',
    workingDirectory: '/workspace/repo',
    ...overrides,
  };
}

describe('invokeAgent', () => {
  beforeEach(() => {
    mockInvokeClaude.mockReset();
    mockInvokeCodex.mockReset();
  });

  it('dispatches to Claude adapter when provider is claude', async () => {
    mockInvokeClaude.mockResolvedValueOnce({ success: true, durationMs: 10 });

    await invokeAgent(makeInvocation({ provider: 'claude' }));

    expect(mockInvokeClaude).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'hello world',
        maxTurns: 10,
      }),
    );
    expect(mockInvokeCodex).not.toHaveBeenCalled();
  });

  it('dispatches to Codex adapter when provider is codex', async () => {
    mockInvokeCodex.mockResolvedValueOnce({ success: true, durationMs: 10 });

    await invokeAgent(makeInvocation({ provider: 'codex' }));

    expect(mockInvokeCodex).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'hello world',
        maxTurns: 10,
      }),
    );
    expect(mockInvokeClaude).not.toHaveBeenCalled();
  });
});
