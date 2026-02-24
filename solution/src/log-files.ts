import { appendFileSync, mkdirSync } from 'node:fs';

let logDir: string | null = null;

export function initLogDir(dir: string): void {
  logDir = dir;
  mkdirSync(dir, { recursive: true });
}

export function appendToLog(filename: string, content: string): void {
  if (!logDir) return;
  try {
    appendFileSync(`${logDir}/${filename}`, content + '\n');
  } catch {
    // Silently ignore log write failures — don't crash the agent
  }
}
