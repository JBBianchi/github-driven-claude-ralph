import { execa } from 'execa';
import { appendToLog } from './log-files.js';
import type { ClaudeInvocation, ClaudeResult } from './types.js';

const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

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
  appendToLog('claude.log', `[${ts}] INVOKE claude ${args.filter((a) => a !== invocation.prompt).join(' ')}\nPROMPT:\n${invocation.prompt}\n`);

  try {
    const { stdout, stderr } = await execa('claude', args, {
      cwd: invocation.workingDirectory,
      timeout: TIMEOUT_MS,
      stdin: 'ignore',
    });

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
        success = false;
        const errors = parsed.errors?.join('\n') ?? 'Unknown error';
        console.error(`[claude] execution error: ${errors}`);
        appendToLog('claude.log', `[${new Date().toISOString()}] EXECUTION ERROR (${durationMs}ms)\n${stdout}\n===`);
        return { success: false, sessionId, durationMs };
      }

      // For callers expecting text, extract the result field
      if (invocation.outputFormat === 'text' && parsed.result !== undefined) {
        result = parsed.result;
      }
    } catch {
      // Not valid JSON — use raw stdout as result
    }

    appendToLog('claude.log', `[${new Date().toISOString()}] SUCCESS (${durationMs}ms)\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr ?? '(none)'}\n===`);

    return { success, sessionId, result, durationMs };
  } catch (error: unknown) {
    const durationMs = Date.now() - start;
    const message = error instanceof Error ? error.message : String(error);
    const stderr = (error as any)?.stderr ?? '';
    console.error(`[claude] invocation failed (${durationMs}ms): ${message}`);
    if (stderr) console.error(`[claude] stderr: ${stderr}`);
    appendToLog('claude.log', `[${new Date().toISOString()}] FAILED (${durationMs}ms)\nERROR: ${message}\nSTDERR: ${stderr}\n===`);
    return { success: false, durationMs };
  }
}
