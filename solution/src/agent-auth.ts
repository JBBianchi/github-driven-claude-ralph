const CLAUDE_AUTH_FAILURE_PATTERNS = [
  'failed to authenticate',
  'authentication_error',
  'oauth token has expired',
  'please obtain a new token',
  ' 401',
];

/** Prefix used for fatal provider authentication errors across all adapters. */
export const AGENT_AUTH_FAILURE_PREFIX = 'Agent authentication failed:';

/**
 * Returns whether an error should be treated as a fatal authentication failure.
 *
 * @param error - Unknown thrown value.
 * @returns `true` when the normalized fatal auth prefix is present.
 */
export function isFatalAgentAuthError(error: unknown): boolean {
  return String(error).includes(AGENT_AUTH_FAILURE_PREFIX);
}

function includesAuthPattern(message: string, patterns: string[]): boolean {
  const normalized = message.toLowerCase();
  return patterns.some((pattern) => normalized.includes(pattern));
}

/**
 * Throws a normalized fatal error when Claude output indicates auth failure.
 *
 * @param rawMessage - Raw output/error text to inspect.
 */
export function throwIfClaudeAuthFailure(rawMessage: string): void {
  if (!includesAuthPattern(rawMessage, CLAUDE_AUTH_FAILURE_PATTERNS)) {
    return;
  }

  if (rawMessage.includes('OAuth token has expired')) {
    throw new Error(`${AGENT_AUTH_FAILURE_PREFIX} Claude OAuth token has expired.`);
  }

  throw new Error(`${AGENT_AUTH_FAILURE_PREFIX} Claude credentials are invalid or expired.`);
}

/**
 * Throws a normalized fatal error when Codex output indicates auth failure.
 *
 * @param rawMessage - Raw output/error text to inspect.
 */
export function throwIfCodexAuthFailure(rawMessage: string): void {
  const normalized = rawMessage.toLowerCase();
  const isDefinitiveAuthFailure = (
    normalized.includes('not logged in')
    || normalized.includes('login required')
    || normalized.includes('please run codex login')
    || normalized.includes('invalid api key')
    || normalized.includes('incorrect api key')
    || (
      normalized.includes('authentication failed')
      && (
        normalized.includes('codex')
        || normalized.includes('openai')
        || normalized.includes('api key')
      )
    )
  );

  if (!isDefinitiveAuthFailure) {
    return;
  }

  throw new Error(`${AGENT_AUTH_FAILURE_PREFIX} Codex credentials are invalid, missing, or expired.`);
}
