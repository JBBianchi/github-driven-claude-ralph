import { appendToLog } from './log-files.js';
import type { Logger, Role } from './types.js';

export function createLogger(role: Role, executorId?: string): Logger {
  const prefix = executorId ? `[${role}:${executorId}]` : `[${role}]`;

  function formatMessage(
    level: string,
    message: string,
    context?: Record<string, unknown>,
  ): string {
    const timestamp = new Date().toISOString();
    let line = `[${timestamp}] ${prefix} ${level}: ${message}`;
    if (context && Object.keys(context).length > 0) {
      line += ` ${JSON.stringify(context)}`;
    }
    return line;
  }

  return {
    info(message: string, context?: Record<string, unknown>): void {
      const formatted = formatMessage('INFO', message, context);
      console.log(formatted);
      appendToLog('agent.log', formatted);
    },
    warn(message: string, context?: Record<string, unknown>): void {
      const formatted = formatMessage('WARN', message, context);
      console.warn(formatted);
      appendToLog('agent.log', formatted);
    },
    error(message: string, context?: Record<string, unknown>): void {
      const formatted = formatMessage('ERROR', message, context);
      console.error(formatted);
      appendToLog('agent.log', formatted);
    },
  };
}
