import { describe, expect, test } from 'bun:test';
import { type LogLevel, createLogger } from './logger';

describe('createLogger', () => {
  test('emits all four level methods', () => {
    const log = createLogger('smoke');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  test('routes lines through the custom writer with prefix + meta', () => {
    const lines: Array<{ level: LogLevel; line: string }> = [];
    const log = createLogger('test', {
      level: 'debug',
      write: (level, line) => lines.push({ level, line }),
    });

    log.info('hello', { userId: 42 });
    log.error('boom');

    expect(lines).toHaveLength(2);
    expect(lines[0]?.line).toBe('[INFO] test: hello {"userId":42}');
    expect(lines[1]?.line).toBe('[ERROR] test: boom');
  });

  test('filters below the configured level', () => {
    const lines: string[] = [];
    const log = createLogger('filtered', {
      level: 'warn',
      write: (_level, line) => lines.push(line),
    });

    log.debug('ignored');
    log.info('also ignored');
    log.warn('kept');
    log.error('kept');

    expect(lines).toEqual(['[WARN] filtered: kept', '[ERROR] filtered: kept']);
  });
});
