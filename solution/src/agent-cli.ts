import { invokeClaude } from './claude.js';
import { invokeCodex } from './codex.js';
import type { AgentInvocation, AgentResult } from './types.js';

/**
 * Dispatches a provider-neutral invocation to the selected agent CLI adapter.
 *
 * @param invocation - Provider-neutral invocation payload.
 * @returns Normalized invocation result.
 */
export async function invokeAgent(invocation: AgentInvocation): Promise<AgentResult> {
  const { provider, ...adapterInvocation } = invocation;

  return provider === 'codex'
    ? invokeCodex(adapterInvocation)
    : invokeClaude(adapterInvocation);
}
