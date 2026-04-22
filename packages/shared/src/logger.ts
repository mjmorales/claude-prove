export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface LoggerOptions {
  /** Minimum level that will be emitted. Default: 'info'. */
  level?: LogLevel;
  /** Override destination. Default: stderr for warn/error, stdout otherwise. */
  write?: (level: LogLevel, line: string) => void;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Create a named structured logger. Lines are emitted as:
 *   [LEVEL] name: msg {"k":"v",...}
 *
 * Meta is JSON-encoded when present. Intended for CLI/agent observability —
 * not a production telemetry client. Domain packages should build on top of
 * this when they need log aggregation, sampling, or redaction.
 */
export function createLogger(name: string, opts: LoggerOptions = {}): Logger {
  const minWeight = LEVEL_WEIGHT[opts.level ?? 'info'];
  const writer =
    opts.write ??
    ((level: LogLevel, line: string): void => {
      const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      stream.write(`${line}\n`);
    });

  const emit =
    (level: LogLevel) =>
    (msg: string, meta?: Record<string, unknown>): void => {
      if (LEVEL_WEIGHT[level] < minWeight) return;
      const prefix = `[${level.toUpperCase()}] ${name}: ${msg}`;
      const hasMeta = meta && Object.keys(meta).length > 0;
      const line = hasMeta ? `${prefix} ${JSON.stringify(meta)}` : prefix;
      writer(level, line);
    };

  return {
    debug: emit('debug'),
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  };
}
