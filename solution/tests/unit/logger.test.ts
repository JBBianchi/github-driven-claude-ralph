import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createLogger } from '../../src/logger.js';

describe('createLogger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('info() writes structured output with ISO timestamp', () => {
    const logger = createLogger('planner');
    logger.info('test message');

    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(output).toContain('[planner]');
    expect(output).toContain('INFO:');
    expect(output).toContain('test message');
  });

  it('info() includes JSON context when provided', () => {
    const logger = createLogger('planner');
    logger.info('msg', { taskId: 42, branch: 'main' });

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('"taskId":42');
    expect(output).toContain('"branch":"main"');
  });

  it('warn() writes via console.warn with WARN prefix', () => {
    const logger = createLogger('planner');
    logger.warn('warning text');

    expect(warnSpy).toHaveBeenCalledOnce();
    const output = warnSpy.mock.calls[0][0] as string;
    expect(output).toContain('WARN:');
    expect(output).toContain('warning text');
  });

  it('error() writes via console.error with ERROR prefix', () => {
    const logger = createLogger('planner');
    logger.error('failure', { err: 'detail' });

    expect(errorSpy).toHaveBeenCalledOnce();
    const output = errorSpy.mock.calls[0][0] as string;
    expect(output).toContain('ERROR:');
    expect(output).toContain('failure');
    expect(output).toContain('"err":"detail"');
  });

  it('executor logger includes executorId in prefix', () => {
    const logger = createLogger('executor', 'executor-03');
    logger.info('hello');

    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('[executor:executor-03]');
  });

  it('handles empty context gracefully', () => {
    const logger = createLogger('planner');
    logger.info('msg', {});

    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0][0] as string;
    expect(output).toContain('msg');
  });
});
