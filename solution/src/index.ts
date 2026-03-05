import type { Role } from './types.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { initLogDir } from './log-files.js';
import { validateSigningSetup } from './signing.js';
import { ensureLabels } from './github.js';
import { runPlannerLoop } from './planner.js';
import { runExecutorLoop } from './executor.js';

export function parseRole(arg: string | undefined): Role {
  if (arg !== 'planner' && arg !== 'executor') {
    throw new Error(`Invalid role: "${arg}". Expected: planner or executor`);
  }
  return arg;
}

export function setupShutdownHandler(): { shouldContinue: () => boolean } {
  let shuttingDown = false;
  process.on('SIGTERM', () => {
    shuttingDown = true;
  });
  return { shouldContinue: () => !shuttingDown };
}

async function main(): Promise<void> {
  const role = parseRole(process.argv[2]);
  const config = loadConfig(role);

  const logDirName = role === 'executor' ? config.executorId : role;
  initLogDir(`/workspace/logs/${logDirName}`);

  const logger = createLogger(role, role === 'executor' ? config.executorId : undefined);

  logger.info('Agent starting', {
    role,
    repoSlug: config.repoSlug,
    provider: config.agentProvider,
    model: config.agentModel ?? '(provider default)',
  });

  const { shouldContinue } = setupShutdownHandler();

  await validateSigningSetup(config);
  await ensureLabels(config);

  if (role === 'planner') {
    await runPlannerLoop(config, logger, shouldContinue);
  } else {
    await runExecutorLoop(config, logger, shouldContinue);
  }

  logger.info('Agent stopped', { role });
}

// Only run main when executed directly (not imported in tests)
const isDirectExecution =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('index.ts'));

if (isDirectExecution) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
