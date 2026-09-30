import { EnvParser } from './config/EnvParser';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

function isLogLevel(level: string): level is LogLevel {
  return (['debug', 'info', 'warn', 'error'] as const).includes(level as LogLevel);
}

/**
 * Where the level comes from.
 *
 * Workers have no `process.env`, so the injected `env` is the real source and the
 * Node fallback exists only for local tooling. `EnvParser` owns the read, as it
 * owns every other one: this reached for `process.env.LOG_LEVEL` itself, which
 * meant two definitions of what a log level is, and a setting declared in
 * `ServiceEnv` that nothing else could see.
 *
 * An unrecognised value falls back to `info` rather than throwing, and the Node
 * fallback is consulted first only when the injected env says nothing — a logger
 * that refuses to construct is a logger that takes the request down with it.
 */
function resolveLogLevel(env?: unknown): LogLevel {
  const configured = EnvParser.string(env, 'LOG_LEVEL', '').trim().toLowerCase();
  if (isLogLevel(configured)) return configured;
  const fromProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LOG_LEVEL?.trim().toLowerCase();
  return fromProcess && isLogLevel(fromProcess) ? fromProcess : 'info';
}

export function createLogger(namespace?: string, fullRepoName?: string, env?: unknown) {
  const currentLevel = resolveLogLevel(env);
  const minLevel = LOG_LEVELS[currentLevel];

  const argsStr = [fullRepoName, namespace]
    .filter(Boolean)
    .map((s) => `[${s}]`)
    .join(' ');

  // The message and any context object are passed as their own console
  // arguments rather than interpolated into the prefix. Cloudflare's log
  // pipeline only indexes JSON fields for non-string arguments, so folding a
  // message into the prefix would flatten it into one opaque blob; a separate
  // object argument keeps its fields queryable. The prefix stays first for
  // human readability.
  return {
    debug: (...args: unknown[]) => {
      if (LOG_LEVELS.debug >= minLevel) {
        console.debug(`[DEBUG] ${argsStr}`, ...args);
      }
    },
    info: (...args: unknown[]) => {
      if (LOG_LEVELS.info >= minLevel) {
        console.info(`[INFO] ${argsStr}`, ...args);
      }
    },
    warn: (...args: unknown[]) => {
      if (LOG_LEVELS.warn >= minLevel) {
        console.warn(`[WARN] ${argsStr}`, ...args);
      }
    },
    error: (...args: unknown[]) => {
      if (LOG_LEVELS.error >= minLevel) {
        console.error(`[ERROR] ${argsStr}`, ...args);
      }
    },
  };
}

export type { LogLevel };
