import { describe, expect, test } from 'bun:test';
import {
  DEV_INVOCATION_PREFIX,
  PLUGIN_DIR_SHELL_EXPR,
  resolveBinaryPath,
} from '../src/resolve-binary-path';

describe('resolveBinaryPath', () => {
  test('dev mode returns the shell-interpolated invocation prefix', () => {
    expect(resolveBinaryPath('dev')).toBe(
      'bun run "${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}/packages/cli/bin/run.ts"',
    );
  });

  test('dev prefix matches the exported DEV_INVOCATION_PREFIX constant', () => {
    expect(resolveBinaryPath('dev')).toBe(DEV_INVOCATION_PREFIX);
  });

  test('dev prefix contains no machine-absolute path', () => {
    expect(resolveBinaryPath('dev')).not.toMatch(/\/Users\/|\/home\//);
  });

  test('PLUGIN_DIR_SHELL_EXPR falls back to the default plugin install path', () => {
    expect(PLUGIN_DIR_SHELL_EXPR).toBe('${CLAUDE_PROVE_PLUGIN_DIR:-$HOME/.claude/plugins/prove}');
  });

  test('compiled mode defaults to the $HOME-relative binary, expanded at fire time', () => {
    expect(resolveBinaryPath('compiled', {})).toBe('"$HOME/.local/bin/claude-prove"');
  });

  test('compiled mode honors an explicit binaryPath override verbatim', () => {
    expect(resolveBinaryPath('compiled', { binaryPath: '/opt/prove/bin/claude-prove' })).toBe(
      '/opt/prove/bin/claude-prove',
    );
  });
});
