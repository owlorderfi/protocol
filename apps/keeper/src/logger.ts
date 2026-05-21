import { getConfig } from './config';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof LEVELS;

let _threshold: number | null = null;

function threshold(): number {
  if (_threshold === null) _threshold = LEVELS[getConfig().LOG_LEVEL];
  return _threshold;
}

function emit(level: Level, args: unknown[]): void {
  if (LEVELS[level] < threshold()) return;
  const ts = new Date().toISOString();
  const out = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  out(`${ts} [${level.toUpperCase()}]`, ...args);
}

export const log = {
  debug: (...args: unknown[]) => emit('debug', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
};
