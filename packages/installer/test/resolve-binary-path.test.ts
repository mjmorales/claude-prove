import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveBinaryPath } from '../src/resolve-binary-path';

describe('resolveBinaryPath', () => {
  test('dev mode returns `bun run <pluginRoot>/packages/cli/bin/run.ts`', () => {
    const pluginRoot = '/tmp/fake-plugin';
    const expected = `bun run ${join(pluginRoot, 'packages', 'cli', 'bin', 'run.ts')}`;
    expect(resolveBinaryPath('dev', { pluginRoot })).toBe(expected);
  });

  test('dev mode throws when pluginRoot is missing', () => {
    expect(() => resolveBinaryPath('dev', {})).toThrow(/pluginRoot/);
  });

  test('compiled mode defaults to $HOME/.local/bin/claude-prove', () => {
    const expected = join(homedir(), '.local', 'bin', 'claude-prove');
    expect(resolveBinaryPath('compiled', {})).toBe(expected);
  });

  test('compiled mode honors an explicit binaryPath override', () => {
    expect(resolveBinaryPath('compiled', { binaryPath: '/opt/prove/bin/claude-prove' })).toBe(
      '/opt/prove/bin/claude-prove',
    );
  });

  test('compiled mode ignores pluginRoot', () => {
    const expected = join(homedir(), '.local', 'bin', 'claude-prove');
    expect(resolveBinaryPath('compiled', { pluginRoot: '/tmp/anything' })).toBe(expected);
  });
});
