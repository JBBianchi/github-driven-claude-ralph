import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseRole, setupShutdownHandler } from '../../src/index.js';

describe('parseRole', () => {
  it('returns planner for argument "planner"', () => {
    expect(parseRole('planner')).toBe('planner');
  });

  it('returns executor for argument "executor"', () => {
    expect(parseRole('executor')).toBe('executor');
  });

  it('throws for unknown role', () => {
    expect(() => parseRole('unknown')).toThrow(/planner|executor/);
  });

  it('throws when no argument provided', () => {
    expect(() => parseRole(undefined)).toThrow();
  });
});

describe('setupShutdownHandler', () => {
  let savedListeners: Function[];

  beforeEach(() => {
    savedListeners = process.rawListeners('SIGTERM').slice() as Function[];
    process.removeAllListeners('SIGTERM');
  });

  afterEach(() => {
    process.removeAllListeners('SIGTERM');
    for (const listener of savedListeners) {
      process.on('SIGTERM', listener as NodeJS.SignalsListener);
    }
  });

  it('shouldContinue returns false after SIGTERM', () => {
    const { shouldContinue } = setupShutdownHandler();

    expect(shouldContinue()).toBe(true);
    process.emit('SIGTERM');
    expect(shouldContinue()).toBe(false);
  });
});
